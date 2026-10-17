import { Bot, InlineKeyboard } from "grammy";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createRelay, escapeText, type Relay } from "./relay";
import { createPiClient, type PiClient, type PiResponse } from "./pi-client";
import { scanSessions, formatSessionDate, type SessionInfo } from "./sessions";
import { createSafeEditor, htmlEscape, splitTelegramText, downloadTelegramFile, isParseError, type TelegramApi, type MessageContext, type PhotoMessageContext, type DocumentMessageContext, type VoiceMessageContext } from "./telegram";
import { InjectWatcher } from "./inject";

// ============================================================
// Config (loaded from .env by Bun auto)
// ============================================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PI_PATH = (process.env.PI_PATH ?? "pi").replace(/^~/, homedir());
const SESSION_DIR = (process.env.PI_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions")).replace(/^~/, homedir());
const INJECT_DIR = (process.env.INJECT_DIR ?? join(homedir(), ".pi", "agent", "injects")).replace(/^~/, homedir());
function uploadDir(): string | null {
  return (process.env.UPLOAD_DIR ?? "").replace(/^~/, homedir()) || null;
}

// Verbosity: -v = key events, -vv = + requestPi raw + telegram msg summaries, -vvv = + full JSON + raw pi lines
const verbosity = process.argv.includes("-vvv") ? 3 : process.argv.includes("-vv") ? 2 : process.argv.includes("-v") ? 1 : 0;
const STREAMING_EVENTS = new Set(["message_update", "message_start", "message_end", "turn_start", "turn_end"]);
let streamingDots = 0;

function flushDots(): void {
  if (streamingDots > 0) { process.stderr.write("\n"); streamingDots = 0; }
}

function dbg(level: 1 | 2 | 3, msg: string): void {
  if (verbosity >= level) {
    flushDots();
    console.error(msg);
  }
}

function streamingTick(): void {
  streamingDots++;
  process.stderr.write(".");
}

const allowedUserId = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID ?? "", 10);

// ============================================================
// Pi protocol types
// ============================================================

interface PiEvent {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    reason?: string;
  };
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  messages?: Array<{
    stopReason?: string;
    errorMessage?: string;
  }>;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export function extFromMime(mimeType: string): string {
  const slash = mimeType.indexOf("/");
  if (slash === -1) return ".bin";
  const sub = mimeType.slice(slash + 1);
  const overrides: Record<string, string> = {
    "svg+xml": ".svg",
    "octet-stream": ".bin",
  };
  return overrides[sub] ?? `.${sub}`;
}

interface ModelInfo {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

function toolArgPreview(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (toolName === "write" || toolName === "read" || toolName === "edit") {
    const path = args.path;
    if (typeof path === "string") {
      return path.length <= 50 ? path : "…" + path.slice(path.length - 49);
    }
  }
  if (toolName === "bash") {
    const cmd = args.command;
    if (typeof cmd === "string") {
      const line = cmd.split("\n")[0]!.trim();
      return line.length <= 60 ? line : line.slice(0, 60) + "…";
    }
  }
  if (toolName === "codemode") {
    const code = args.code;
    if (typeof code === "string") {
      // First non-comment, non-blank line — the options line (`//!...`) is skipped.
      const line = code.split("\n").map((l) => l.trim())
        .find((l) => l && !l.startsWith("//")) ?? "";
      return line.length <= 60 ? line : line.slice(0, 60) + "…";
    }
  }
  return null;
}

// ============================================================
// Gateway: all mutable state + business logic
// ============================================================

export class Gateway {
  piClient: PiClient | null = null;
  piStreaming = false;
  currentRelay: Relay | null = null;
  currentChatId: number | string = 0;
  currentPlaceholderMessageId: number = 0;
  toolMessages: Map<string, { msgId: number; startText: string }> = new Map();
  lastPiError?: string;
  piErrorSent = false;
  turnToolCounts: Map<string, number> = new Map();
  lastTypingSent = 0;
  currentSessionId: string | null = null;
  sessionPicker: Map<string, SessionInfo> = new Map();
  allowedUserId: number;
  api: TelegramApi;
  botToken: string;
  downloadFile = (fileId: string) => downloadTelegramFile(this.api, this.botToken, fileId);
  deleteFile: (path: string) => Promise<void> = unlink;
  startedAt = new Date();

  constructor(options: { allowedUserId: number; api: TelegramApi; botToken?: string }) {
    this.allowedUserId = options.allowedUserId;
    this.api = options.api;
    this.botToken = options.botToken ?? "";
  }

  async saveUpload(buffer: Buffer, mimeType: string, filename?: string): Promise<string | null> {
    const dir = uploadDir();
    if (!dir) return null;
    const ext = extFromMime(mimeType);
    const name = filename ?? `${Date.now()}${ext}`;
    const target = join(dir, name);
    try {
      await writeFile(target, buffer);
      return target;
    } catch (err) {
      console.error(`[upload] failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Called by pi-client for every event, in order. Must never await
  // requestPi(): responses resolve on the same queue, so that would deadlock.
  handlePiEvent = async (event: PiEvent | PiResponse): Promise<void> => {
    const type = event.type;
    if (STREAMING_EVENTS.has(type)) {
      if (verbosity >= 3) dbg(3, `pi event type=${type}`);
      else streamingTick();
    } else {
      dbg(1, `pi event type=${type}`);
    }
    if (verbosity >= 3) {
      flushDots();
      console.error(`[pi] event JSON: ${JSON.stringify(event)}`);
    }

    if (type !== "response" && type !== "agent_end" && type !== "agent_settled" && this.currentChatId) {
      this.sendTyping(this.currentChatId);
    }

    // Responses to requestPi() are consumed by pi-client; anything left here
    // has an unknown id (e.g. arrived after pi restarted).
    if (type === "response") {
      dbg(1, `unmatched pi response: ${(event as PiResponse).command}`);
      return;
    }

    if (type === "message_update") {
      const delta = (event as PiEvent).assistantMessageEvent;
      if (delta?.type === "text_delta" && delta.delta) {
        this.currentRelay?.onDelta(delta.delta);
      } else if (delta?.type === "error") {
        const reason = delta.reason ?? "unknown";
        console.error(`[pi] stream error: ${reason}`);
        if (verbosity >= 3) {
          flushDots();
          console.error(`[pi] stream error JSON: ${JSON.stringify(event)}`);
        }
      }
      return;
    }

    if (type === "message_start") {
      const msg = (event as PiEvent).message;
      if (msg?.role === "assistant" && this.currentChatId) {
        if (this.currentRelay) {
          await this.currentRelay.onDone();
          this.currentRelay = null;
        }
        let placeholder: { message_id: number };
        try {
          placeholder = await this.api.sendMessage(this.currentChatId, "🤔 _Thinking…_", { parse_mode: "MarkdownV2" });
        } catch (err) {
          console.error(`[telegram] failed to send message (chat=${this.currentChatId}): ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        this.currentPlaceholderMessageId = placeholder.message_id;
        const editor = createSafeEditor(this.api, this.currentChatId, this.currentPlaceholderMessageId, (msg) => dbg(1, msg));
        this.currentRelay = createRelay({
          edit: (buf, isFinal) =>
            editor.edit(buf, isFinal).catch((err: Error) =>
              console.error(`[telegram] edit failed: ${err.message}`),
            ),
          log: (msg) => dbg(1, msg),
        });
      }
      return;
    }

    if (type === "message_end") {
      const msg = (event as PiEvent).message;
      if (msg?.stopReason === "error" && msg.errorMessage) {
        console.error(`[pi] message error: ${msg.errorMessage}`);
        if (verbosity >= 1) {
          console.error(`[pi] error context: stopReason=${msg.stopReason}`);
        }
        this.lastPiError = msg.errorMessage;
      }
      if (this.currentRelay) {
        const hadContent = await this.currentRelay.onDone();
        if (!hadContent && this.lastPiError && this.currentChatId && !this.piErrorSent) {
          try {
            if (this.currentPlaceholderMessageId) {
              await this.api.editMessageText(
                this.currentChatId,
                this.currentPlaceholderMessageId,
                `❌ Error: ${this.lastPiError}`,
              );
            } else {
              const sent = await this.api.sendMessage(this.currentChatId, `❌ Error: ${this.lastPiError}`);
              this.currentPlaceholderMessageId = sent.message_id;
            }
            this.piErrorSent = true;
          } catch (err) {
            console.error(`[telegram] error message failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!hadContent && this.currentChatId && this.currentPlaceholderMessageId) {
          this.api.deleteMessage?.(this.currentChatId, this.currentPlaceholderMessageId)?.catch((err: Error) => {
            dbg(1, `[telegram] delete stale placeholder failed: ${err.message}`);
          });
        }
        this.currentRelay = null;
      }
      return;
    }

    // agent_end closes only one low-level agent run; retries/recovery may
    // continue after it. Use agent_settled (below) as the true idle signal.
    if (type === "agent_end") {
      dbg(1, `agent_end`);

      const messages = (event as PiEvent).messages;
      const errorMsg = messages?.find(m => m.stopReason === 'error')?.errorMessage;
      if (errorMsg && !this.lastPiError) {
        console.error(`[pi] agent error: ${errorMsg}`);
        if (verbosity >= 1) {
          console.error(`[pi] error context: messages=${messages?.length ?? 0}`);
        }
        this.lastPiError = errorMsg;
      }

      const hadContent = await this.currentRelay?.onDone();
      if (hadContent && this.lastPiError) {
        dbg(1, `agent ended with error but content was produced: ${this.lastPiError}`);
      }
      if (!hadContent && this.lastPiError && this.currentChatId && !this.piErrorSent) {
        try {
          if (this.currentPlaceholderMessageId) {
            await this.api.editMessageText(
              this.currentChatId,
              this.currentPlaceholderMessageId,
              `❌ Error: ${this.lastPiError}`,
            );
          } else {
            const sent = await this.api.sendMessage(this.currentChatId, `❌ Error: ${this.lastPiError}`);
            this.currentPlaceholderMessageId = sent.message_id;
          }
          this.piErrorSent = true;
        } catch (err) {
          console.error(`[telegram] error message failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (this.turnToolCounts.size > 0 && this.currentChatId) {
        const entries = [...this.turnToolCounts.entries()];
        entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const total = entries.reduce((s, [, c]) => s + c, 0);
        const parts = entries.map(([n, c]) => c > 1 ? `${n} \u00d7${c}` : n);
        const text = `\uD83D\uDD27 ${total} tools used: ${parts.join(', ')}`;
        this.turnToolCounts.clear();
        this.api.sendMessage(this.currentChatId, text)
          .catch((err) => {
            console.error(`[telegram] tool summary send failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      this.currentRelay = null;
      this.lastPiError = undefined;
      this.piErrorSent = false;
      return;
    }

    if (type === "agent_settled") {
      dbg(1, `agent_settled`);
      this.piStreaming = false;
      this.currentChatId = 0;
      this.currentPlaceholderMessageId = 0;
      return;
    }

    if (type === "tool_execution_start") {
      const e = event as PiEvent;
      const { toolName, toolCallId, args } = e;
      if (toolName && typeof toolName === 'string') {
        this.turnToolCounts.set(toolName, (this.turnToolCounts.get(toolName) ?? 0) + 1);
        if (this.currentChatId) {
          const preview = toolArgPreview(toolName, args as Record<string, unknown> | undefined);
          const tn = htmlEscape(toolName);
          const text = preview
            ? `🔧 <code>${tn}</code> ${preview}`
            : `🔧 <code>${tn}</code>...`;
          try {
            const sent = await this.api.sendMessage(this.currentChatId, text, { parse_mode: "HTML" });
            if (toolCallId) this.toolMessages.set(toolCallId, { msgId: sent.message_id, startText: text });
          } catch (err) {
            dbg(1, `[telegram] send tool start failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return;
    }

    if (type === "tool_execution_end") {
      const e = event as PiEvent;
      const { toolName, toolCallId } = e;
      if (toolName && typeof toolName === 'string' && this.currentChatId) {
        const entry = toolCallId ? this.toolMessages.get(toolCallId) : undefined;
        if (entry) {
          this.api.editMessageText(
            this.currentChatId,
            entry.msgId,
            entry.startText.replace("🔧", "✅"),
            { parse_mode: "HTML" },
          ).catch((err: Error) => {
            dbg(1, `[telegram] edit tool end failed: ${err.message}`);
          });
        }
      }
      return;
    }

    // XXX: other events not handled yet (extension_ui, etc.)
    // Known no-op events we deliberately ignore (avoid log noise):
    if (type === "agent_start" || type === "turn_start" || type === "turn_end") return;
    dbg(1, `unhandled pi event type: ${type}`);
  };

  sendTyping(chatId: number | string): void {
    const now = Date.now();
    if (now - this.lastTypingSent < 4000) return;
    this.lastTypingSent = now;
    dbg(1, `typing → ${chatId}`);
    this.api.sendChatAction?.(chatId, "typing")?.catch((err: Error) => {
      console.error(`[telegram] sendChatAction failed: ${err.message}`);
    });
  }

  // Sends a command to pi and resolves with its response (never rejects).
  // Failures are logged here; callers decide what to show the user.
  async requestPi(cmd: Record<string, unknown>): Promise<PiResponse> {
    dbg(2, `requestPi: ${JSON.stringify(cmd)}`);
    const command = String(cmd.type);
    if (!this.piClient) {
      console.error(`[pi] cannot send ${command} (pi not connected)`);
      return { type: "response", command, success: false, error: "pi not connected" };
    }
    const resp = await this.piClient.request(cmd);
    if (!resp.success) console.error(`[pi] error (${command}): ${resp.error}`);
    else dbg(1, `pi response ok: ${command}`);
    return resp;
  }

  async reply(chatId: number | string, text: string, extra?: Record<string, unknown>): Promise<void> {
    await this.api.sendMessage(chatId, text, extra).catch((err: Error) =>
      console.error(`[telegram] reply failed: ${err.message}`),
    );
  }

  // Resolves after pi's prompt response (preflight), not after the run.
  async startPiSession(
    chatId: number | string,
    text: string,
    api: TelegramApi = this.api,
    images?: ImageContent[],
  ): Promise<void> {
    dbg(1, `startPiSession chat=${chatId} text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" images=${images?.length ?? 0}`);
    this.piStreaming = true;
    this.currentChatId = chatId;
    this.lastPiError = undefined;
    this.piErrorSent = false;
    this.currentPlaceholderMessageId = 0;
    this.toolMessages.clear();

    const cmd: Record<string, unknown> = { type: "prompt", message: text };
    if (images && images.length > 0) cmd.images = images;
    const resp = await this.requestPi(cmd);
    const disposition = (resp.data as { disposition?: string } | undefined)?.disposition;
    if (resp.success && disposition !== "handled") return;

    // No run started (an extension command consumed the prompt, or pi rejected
    // it): no agent_settled will follow, so go idle here.
    // XXX: messages steered while this prompt was in preflight stay queued in pi
    dbg(1, `prompt started no run (success=${resp.success} disposition=${disposition})`);
    this.piStreaming = false;
    this.currentChatId = 0;
    if (!resp.success) await this.reply(chatId, `❌ ${resp.error ?? "Prompt failed"}`);
  }

  // Steer a message into pi's current run. Falls back to a fresh prompt run if
  // pi rejects the steer (e.g. sent right at agent_end — piStreaming is only
  // cleared on agent_settled, so that race can happen) or an input handler
  // consumed it without starting work (disposition "handled").
  async steerPi(
    chatId: number | string,
    text: string,
    api: TelegramApi = this.api,
    images?: ImageContent[],
  ): Promise<void> {
    const cmd: Record<string, unknown> = { type: "steer", message: text };
    if (images && images.length > 0) cmd.images = images;
    const resp = await this.requestPi(cmd);
    const disposition = (resp.data as { disposition?: string } | undefined)?.disposition;
    if (resp.success && disposition === "queued") return;
    dbg(1, `steer not queued (success=${resp.success} disposition=${disposition}), resending as prompt`);
    await this.startPiSession(chatId, text, api, images);
  }

  // Abort pi and drain its steering/follow-up queues. Called by /abort.
  // clear_queue is sent first so pi returns the queued texts instead of
  // running them after abort (abort alone continues the run with queued
  // messages remaining — pi RPC docs). Replies plain "🛑 Aborted." if the
  // clear_queue response takes longer than 1500ms.
  async abortPi(chatId: number | string): Promise<void> {
    this.currentRelay?.cancel();
    this.currentRelay = null;
    this.piStreaming = false;
    this.turnToolCounts.clear();
    const cleared = this.requestPi({ type: "clear_queue" });
    void this.requestPi({ type: "abort" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1500); });
    const resp = await Promise.race([cleared, timeout]);
    clearTimeout(timer);
    const d = resp?.success ? resp.data as { steering?: string[]; followUp?: string[] } | undefined : undefined;
    const queued = (d?.steering?.length ?? 0) + (d?.followUp?.length ?? 0);
    await this.reply(chatId, queued ? `🛑 Aborted. Cleared ${queued} queued messages.` : "🛑 Aborted.");
  }

  resetSession(caller: string): void {
    dbg(1, `resetSession (${caller})`);
    this.currentRelay?.cancel();
    this.currentRelay = null;
    this.piStreaming = false;
    this.turnToolCounts.clear();
    this.toolMessages.clear();
    this.currentChatId = 0;
    this.currentPlaceholderMessageId = 0;
    this.lastPiError = undefined;
    this.piErrorSent = false;
    this.currentSessionId = null;
  }

  scanRecentSessions(limit: number = 12, sessionDir?: string): SessionInfo[] {
    const dir = sessionDir ?? SESSION_DIR;
    dbg(1, `scanRecentSessions dir=${dir}`);

    const sessions = scanSessions(dir, limit);
    dbg(1, `scanRecentSessions: found ${sessions.length} sessions`);

    this.sessionPicker.clear();
    for (const s of sessions) {
      this.sessionPicker.set(s.id, s);
    }

    return sessions;
  }

  async switchToSession(chatId: number | string, sessionId: string): Promise<void> {
    const info = this.sessionPicker.get(sessionId);
    if (!info) {
      console.error(`[gateway] switchToSession: session ${sessionId} not in picker`);
      return;
    }

    dbg(1, `switchToSession: ${info.id} -> ${info.path}`);
    this.resetSession("switchToSession");
    const resp = await this.requestPi({ type: "switch_session", sessionPath: info.path });
    if (!resp.success) {
      await this.reply(chatId, `❌ Switch failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.cmdState(chatId);
  }

  // ------------------------------------------------------------
  // Slash command handlers — called from the bot wiring at the bottom of this
  // file. Each awaits its pi response and replies to chatId. The bot wiring
  // fires them with `void`: grammy handles updates one at a time, so awaiting
  // a slow command (e.g. /compact) there would block /abort.
  // ------------------------------------------------------------

  // Also called after /new, /delete, /resume and at startup
  async cmdState(chatId: number | string): Promise<void> {
    const resp = await this.requestPi({ type: "get_state" });
    if (!resp.success) {
      await this.reply(chatId, `❌ Status failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    const data = resp.data as { sessionId?: string } | undefined;
    if (data?.sessionId) this.currentSessionId = data.sessionId;
    await this.showStatus(chatId, resp.data);
  }

  async cmdNew(chatId: number | string): Promise<void> {
    this.resetSession("/new");
    const resp = await this.requestPi({ type: "new_session" });
    if (!resp.success) {
      await this.reply(chatId, `❌ New session failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.reply(chatId, "🆕 New session. Ready to roll 🫡");
    await this.cmdState(chatId);
  }

  async cmdDelete(chatId: number | string): Promise<void> {
    const sessionId = this.currentSessionId;
    if (sessionId) {
      try {
        let info = this.sessionPicker.get(sessionId);
        if (!info) {
          this.scanRecentSessions();
          info = this.sessionPicker.get(sessionId);
        }
        if (info) {
          await this.deleteFile(info.path);
          dbg(1, `deleteSession: unlinked ${info.path}`);
        } else {
          console.error(`[delete] session ${sessionId} not found in picker; skipping unlink`);
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          console.error(`[delete] unlink failed: ${err?.message ?? err}`);
        }
      }
    } else {
      console.error("[delete] no current session ID to delete");
    }

    this.resetSession("/delete");
    const resp = await this.requestPi({ type: "new_session" });
    if (!resp.success) {
      await this.reply(chatId, `❌ New session failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.reply(chatId, "🗑️ Session deleted. New session: standing by 🫡");
    await this.cmdState(chatId);
  }

  async cmdSession(chatId: number | string): Promise<void> {
    const stats = this.requestPi({ type: "get_session_stats" });
    await this.cmdState(chatId);
    const resp = await stats;
    if (resp.success) await this.showStats(chatId, resp.data);
  }

  async cmdLast(chatId: number | string): Promise<void> {
    const resp = await this.requestPi({ type: "get_last_assistant_text" });
    if (!resp.success) {
      await this.reply(chatId, `❌ ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.showLastMessage(chatId, resp.data);
  }

  async cmdName(chatId: number | string, name: string): Promise<void> {
    const resp = await this.requestPi({ type: "set_session_name", name });
    await this.reply(chatId, resp.success ? "✏️ Named." : `❌ Naming failed: ${resp.error ?? "unknown error"}`);
  }

  async cmdModels(chatId: number | string, filter?: string): Promise<void> {
    const resp = await this.requestPi({ type: "get_available_models" });
    if (!resp.success) {
      await this.reply(chatId, `❌ ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.showModels(chatId, resp.data, filter);
  }

  // Returns the text for the model picker message (edited in place by the caller)
  async setModel(provider: string, modelId: string): Promise<string> {
    const resp = await this.requestPi({ type: "set_model", provider, modelId });
    return resp.success
      ? `✅ Model: ${provider}/${modelId}`
      : `❌ Model switch failed: ${resp.error ?? "unknown error"}`;
  }

  async cmdThinkingLevels(chatId: number | string): Promise<void> {
    const resp = await this.requestPi({ type: "get_available_thinking_levels" });
    if (!resp.success) {
      await this.reply(chatId, `❌ ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.showThinkingLevels(chatId, resp.data);
  }

  async cmdSetThinkingLevel(chatId: number | string, level: string): Promise<void> {
    const resp = await this.requestPi({ type: "set_thinking_level", level });
    await this.reply(chatId, resp.success
      ? `💭 Thinking level: ${level}`
      : `❌ Thinking level failed: ${resp.error ?? "unknown error"}`);
  }

  async cmdCompact(chatId: number | string, customInstructions?: string): Promise<void> {
    const cmd: Record<string, unknown> = { type: "compact" };
    if (customInstructions) cmd.customInstructions = customInstructions;
    const resp = await this.requestPi(cmd);
    if (!resp.success) {
      await this.reply(chatId, `❌ Compaction failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    await this.showCompact(chatId, resp.data);
  }

  async cmdAbortBash(chatId: number | string): Promise<void> {
    const resp = await this.requestPi({ type: "abort_bash" });
    await this.reply(chatId, resp.success ? "🛑 Bash aborted." : `❌ ${resp.error ?? "unknown error"}`);
  }

  // !command / !!command from handleTextMessage
  async runBash(chatId: number | string, command: string, excludeFromContext: boolean): Promise<void> {
    const resp = await this.requestPi({ type: "bash", command, ...(excludeFromContext ? { excludeFromContext: true } : {}) });
    if (!resp.success) {
      await this.reply(chatId, `❌ Bash failed: ${resp.error ?? "unknown error"}`);
      return;
    }
    const d = resp.data as { output?: string; exitCode?: number; truncated?: boolean } | undefined;
    const header = `Exit code: ${d?.exitCode ?? "?"}${d?.truncated ? " (truncated)" : ""}`;
    const output = d?.output ?? "(no output)";
    const chunks = splitTelegramText(`${header}\n\n${output}`, 3900);
    for (const chunk of chunks) {
      await this.reply(chatId, `<pre>${htmlEscape(chunk)}</pre>`, { parse_mode: "HTML" });
    }
  }

  async showStatus(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const model = s.model as { provider?: string; modelId?: string; id?: string } | undefined;
    const modelName = htmlEscape(model
      ? `${model.provider ?? "?"}/${model.modelId ?? model.id ?? "?"}`
      : "?");

    const sessionId = htmlEscape(String(s.sessionId ?? "?"));
    const sessionName = s.sessionName ? htmlEscape(`"${s.sessionName}"`) : "";
    const lines = [
      `🤖 Model:         ${modelName}`,
      `📋 Session:       ${sessionId}${sessionName ? ` (${sessionName})` : ""}`,
      `💬 Messages:      ${s.messageCount ?? 0}${s.pendingMessageCount ? ` (+${s.pendingMessageCount} pending)` : ""}`,
      `💭 Thinking:      ${s.thinkingLevel ?? "?"}`,
    ];
    if (s.sessionFile) {
      const file = String(s.sessionFile);
      lines.push(`📁 Session file:  ${htmlEscape(file)}`);
    }
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStatus failed: ${err.message}`),
    );
  }

  async showThinkingLevels(chatId: number | string, data: unknown): Promise<void> {
    const d = data as { levels?: string[] } | undefined;
    const levels = d?.levels ?? [];

    if (levels.length === 0) {
      await this.api.sendMessage(chatId, "❌ No thinking levels available.").catch((err: Error) =>
        console.error(`[telegram] showThinkingLevels failed: ${err.message}`),
      );
      return;
    }

    const lines = [`💭 Available thinking levels (${levels.length}):`, ""];
    for (const l of levels) lines.push(l);
    const text = `<pre>${htmlEscape(lines.join("\n"))}</pre>`;
    const inline_keyboard = [levels.map(l => ({ text: l, callback_data: `think:${l}` }))];
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard } }).catch((err: Error) =>
      console.error(`[telegram] showThinkingLevels failed: ${err.message}`),
    );
  }

  async showDaemonStatus(chatId: number | string): Promise<void> {
    const now = Date.now();
    const uptimeMs = now - this.startedAt.getTime();
    const uptimeH = Math.floor(uptimeMs / 3600000);
    const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
    const uptimeS = Math.floor((uptimeMs % 60000) / 1000);
    const uptimeStr = `${uptimeH}h ${String(uptimeM).padStart(2, "0")}m ${String(uptimeS).padStart(2, "0")}s`;
    const piStatus = this.piClient
      ? `running (pid=${this.piClient.pid ?? "?"})`
      : "not connected";
    const streaming = this.piStreaming ? "busy" : "idle";
    const lines = [
      `🖥️ Kklaw Daemon`,
      `⏱️ Uptime:        ${uptimeStr}`,
      `🔄 Pi:           ${piStatus}`,
      `📡 Pi streaming: ${streaming}`,
      `📁 Session:      ${this.currentSessionId ? this.currentSessionId.slice(-12) : "none"}`,
      `📑 Cached sessions: ${this.sessionPicker.size}`,
      `🔧 Active tools: ${this.toolMessages.size}`,
    ];
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showDaemonStatus failed: ${err.message}`),
    );
  }

  async showLastMessage(chatId: number | string, data: unknown): Promise<void> {
    const d = data as Record<string, unknown> | undefined;
    if (!d) return;
    const text = d.text as string | null | undefined;
    if (!text) {
      await this.api.sendMessage(chatId, "💬 (No assistant messages yet.)").catch((err: Error) =>
        console.error(`[telegram] showLastMessage failed: ${err.message}`),
      );
      return;
    }
    const chunks = splitTelegramText(text, 4000);
    for (const raw of chunks) {
      // XXX: if this try/catch-with-plain-fallback pattern appears in more
      // call sites, extract a sendMessageSafe() utility
      const md = escapeText(raw);
      try {
        await this.api.sendMessage(chatId, md, { parse_mode: "MarkdownV2" });
      } catch (err) {
        if (isParseError(err)) {
          await this.api.sendMessage(chatId, raw);
        } else {
          console.error(`[telegram] showLastMessage failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  async showModels(chatId: number | string, data: unknown, modelFilter?: string): Promise<void> {
    const d = data as { models?: ModelInfo[] } | undefined;
    const models = d?.models ?? [];

    if (modelFilter) {
      const filter = modelFilter.toLowerCase();
      const matches = models.filter(m =>
        (m.name ?? "").toLowerCase().includes(filter) ||
        (m.id ?? "").toLowerCase().includes(filter) ||
        `${m.provider ?? ""}/${m.id ?? ""}`.toLowerCase().includes(filter)
      );

      if (matches.length === 0) {
        await this.api.sendMessage(chatId, `No models matching "${filter}".`).catch((err: Error) =>
          console.error(`[telegram] showModels failed: ${err.message}`),
        );
        return;
      }

      const inline_keyboard = matches.map(m => [{
        text: `${m.provider}/${m.id}`,
        callback_data: `model:${m.provider}/${m.id}`,
      }]);
      await this.api.sendMessage(chatId, `🔍 Models matching "${filter}":`, {
        reply_markup: { inline_keyboard },
      }).catch((err: Error) =>
        console.error(`[telegram] showModels failed: ${err.message}`),
      );
    } else {
      if (models.length === 0) {
        await this.api.sendMessage(chatId, "No models available.").catch((err: Error) =>
          console.error(`[telegram] showModels failed: ${err.message}`),
        );
        return;
      }

      const lines = [`🤖 Available models (${models.length}):`, ""];
      for (const m of models) {
        const ctx = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}K` : "?";
        const modIcons = ["📝"];
        for (const mod of (m.input as string[] | undefined) ?? []) {
          if (mod === "image") modIcons.push("🏙️");
          else if (mod === "audio") modIcons.push("🎤");
          else if (mod === "video") modIcons.push("🎬");
        }
        const modStr = modIcons.join("");
        const costStr = m.cost ? `$${m.cost.input}/${m.cost.output}` : "?";
        const name = htmlEscape(m.name ?? m.id ?? "?");
        lines.push(`${htmlEscape(m.provider ?? "?")}/${htmlEscape(m.id ?? "?")} — ${name}`);
        lines.push(`  ${modStr}  ${costStr}  ${ctx}`);
      }
      const maxLen = 3900;
      // tagOverhead = strlen("<pre></pre>") = 11
      // reduce adds 1 for a newline after every line (including last); the
      // -1 compensates because join("\n") does not add a trailing newline
      const tagOverhead = 11;
      const totalLen = tagOverhead + lines.reduce((s, l) => s + l.length + 1, 0) - 1;
      if (totalLen <= maxLen) {
        const text = `<pre>${lines.join("\n")}</pre>`;
        await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
          console.error(`[telegram] showModels failed: ${err.message}`),
        );
      } else {
        let start = 0;
        while (start < lines.length) {
          let end = start;
          let curLen = tagOverhead;
          while (end < lines.length) {
            const add = lines[end]!.length + 1;
            if (curLen + add > maxLen && end > start) break;
            curLen += add;
            end++;
          }
          const chunk = lines.slice(start, end).join("\n");
          await this.api.sendMessage(chatId, `<pre>${chunk}</pre>`, { parse_mode: "HTML" }).catch((err: Error) =>
            console.error(`[telegram] showModels failed: ${err.message}`),
          );
          start = end;
        }
      }
    }
  }

  async showCompact(chatId: number | string, data: unknown): Promise<void> {
    const d = data as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
    const tok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
    const lines = ["🗜️ Compacted"];
    if (d?.tokensBefore != null) {
      lines.push(`📥 Context before: ${tok(d.tokensBefore)} tokens`);
    }
    if (d?.estimatedTokensAfter != null) {
      lines.push(`🔄 Context after: ~${tok(d.estimatedTokensAfter)} tokens (est.)`);
    }
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showCompact failed: ${err.message}`),
    );
  }

  async showStats(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const tokens = s.tokens as Record<string, number> | undefined;
    const tok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

    const lines = [
      `📋 Session:       ${htmlEscape(String(s.sessionId ?? "?"))}`,
      `💬 Total messages: ${s.totalMessages ?? 0} (user: ${s.userMessages ?? 0}, assistant: ${s.assistantMessages ?? 0})`,
      `🔧 Tool calls:    ${s.toolCalls ?? 0} / results: ${s.toolResults ?? 0}`,
      `📥 Tokens in:     ${tokens ? tok(tokens.input!) : "?"}`,
      `📤 Tokens out:    ${tokens ? tok(tokens.output!) : "?"}`,
      `💾 Tokens cache:  ${tokens ? `r:${tok(tokens.cacheRead!)} w:${tok(tokens.cacheWrite!)}` : "?"}`,
      `📊 Tokens total:  ${tokens ? tok(tokens.total!) : "?"}`,
      `💰 Cost:          $${s.cost != null ? Number(s.cost).toFixed(4) : "?"}`,
    ];
    if (s.sessionFile) {
      const file = String(s.sessionFile);
      lines.push(`📁 Session file:  ${htmlEscape(file)}`);
    }
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStats failed: ${err.message}`),
    );
  }

  injectPrompt(text: string, filename: string): void {
    const chatId = this.currentChatId || this.allowedUserId;
    dbg(1, `injectPrompt file=${filename} chat=${chatId} text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    if (this.piStreaming) {
      dbg(1, `pi busy, steering injected prompt`);
      void this.steerPi(chatId, text);
      return;
    }

    void this.startPiSession(chatId, text);
  }

  async handleTextMessage(
    ctx: MessageContext,
    api: TelegramApi = this.api,
  ): Promise<void> {
    const userId = ctx.from?.id;
    dbg(1, `message:text from user=${userId} chat=${ctx.chatId} text="${ctx.msg.text?.slice(0, 80)}"`);

    if (userId === undefined || userId !== this.allowedUserId) {
      dbg(1, `rejected user ${userId} (allowed: ${this.allowedUserId})`);
      return;
    }

    const text = ctx.msg.text;
    if (!text) return;

    if (verbosity >= 2) {
      dbg(2, `telegram msg: ${JSON.stringify({ userId, chatId: ctx.chatId, text })}`);
    }

    if (text.startsWith("!")) {
      const excludeFromContext = text.startsWith("!!");
      const command = text.slice(excludeFromContext ? 2 : 1).trim();
      if (!command) {
        await ctx.reply("Usage: !&lt;command&gt;", { parse_mode: "HTML" });
        return;
      }
      void this.runBash(ctx.chatId, command, excludeFromContext);
      return;
    }

    if (this.piStreaming) {
      dbg(1, `pi busy, steering message`);
      await ctx.react("👀");
      void this.steerPi(ctx.chatId, text, api);
      return;
    }

    void this.startPiSession(ctx.chatId, text, api);
  }

  async handlePhotoMessage(
    ctx: PhotoMessageContext,
    api: TelegramApi = this.api,
  ): Promise<void> {
    const userId = ctx.from?.id;
    dbg(1, `message:photo from user=${userId} chat=${ctx.chatId} caption="${ctx.msg.caption?.slice(0, 80) ?? ""}"`);

    if (userId === undefined || userId !== this.allowedUserId) {
      dbg(1, `rejected user ${userId} (allowed: ${this.allowedUserId})`);
      return;
    }

    const text = ctx.msg.caption ?? "";

    if (verbosity >= 2) {
      dbg(2, `telegram photo msg: ${JSON.stringify({ userId, chatId: ctx.chatId, caption: text })}`);
    }

    const photos = ctx.msg.photo;
    if (!photos || photos.length === 0) return;

    const largest = photos.reduce((a, b) =>
      (a.file_size ?? 0) >= (b.file_size ?? 0) ? a : b
    );

    let images: ImageContent[];
    try {
      const buffer = await this.downloadFile(largest.file_id);
      images = [{ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" }];
      const savedName = await this.saveUpload(buffer, "image/jpeg");
      if (savedName) {
        await ctx.reply(`📎 Saved: <code>${htmlEscape(savedName)}</code> — Sending to Pi…`, { parse_mode: "HTML" }).catch(() => {});
      } else {
        await ctx.reply("📤 Not saved (UPLOAD_DIR not set), directly sending to Pi…").catch(() => {});
      }
    } catch (err) {
      console.error(`[telegram] photo download failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to download photo.");
      return;
    }

    if (this.piStreaming) {
      dbg(1, `pi busy, steering message`);
      await ctx.react("👀");
      void this.steerPi(ctx.chatId, text, api, images);
      return;
    }

    void this.startPiSession(ctx.chatId, text, api, images);
  }

  async handleDocumentMessage(
    ctx: DocumentMessageContext,
    api: TelegramApi = this.api,
  ): Promise<void> {
    const userId = ctx.from?.id;
    dbg(1, `message:document from user=${userId} chat=${ctx.chatId} caption="${ctx.msg.caption?.slice(0, 80) ?? ""}"`);

    if (userId === undefined || userId !== this.allowedUserId) {
      dbg(1, `rejected user ${userId} (allowed: ${this.allowedUserId})`);
      return;
    }

    const doc = ctx.msg.document;
    if (!doc?.file_id) return;

    if (!uploadDir()) {
      await ctx.reply("❌ UPLOAD_DIR is not set. Cannot save document.");
      return;
    }

    if (verbosity >= 2) {
      dbg(2, `telegram document msg: ${JSON.stringify({ userId, chatId: ctx.chatId, caption: ctx.msg.caption ?? "", mimeType: doc.mime_type })}`);
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadFile(doc.file_id);
    } catch (err) {
      console.error(`[telegram] document download failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to download document.");
      return;
    }

    const mimeType = doc.mime_type ?? "application/octet-stream";
    const savedName = await this.saveUpload(buffer, mimeType, doc.file_name);
    if (savedName) {
      await ctx.reply(`📎 Saved: <code>${htmlEscape(savedName)}</code> — Pi can access it but was not notified.`, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  async handleVoiceMessage(
    ctx: VoiceMessageContext,
    api: TelegramApi = this.api,
  ): Promise<void> {
    const userId = ctx.from?.id;
    dbg(1, `message:voice from user=${userId} chat=${ctx.chatId}`);

    if (userId === undefined || userId !== this.allowedUserId) {
      dbg(1, `rejected user ${userId} (allowed: ${this.allowedUserId})`);
      return;
    }

    if (!uploadDir()) {
      await ctx.reply("❌ UPLOAD_DIR is not set. Cannot save voice message.");
      return;
    }

    const voice = ctx.msg.voice;
    if (!voice?.file_id) return;

    if (verbosity >= 2) {
      dbg(2, `telegram voice msg: ${JSON.stringify({ userId, chatId: ctx.chatId, mimeType: voice.mime_type, duration: voice.duration })}`);
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadFile(voice.file_id);
    } catch (err) {
      console.error(`[telegram] voice download failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to download voice message.");
      return;
    }

    const mimeType = voice.mime_type ?? "audio/ogg";
    const filename = `voice_${Date.now()}${extFromMime(mimeType)}`;
    const savedName = await this.saveUpload(buffer, mimeType, filename);
    if (!savedName) {
      await ctx.reply("Failed to save voice message.");
      return;
    }

    const prompt = `voice message from user: ${savedName}`;
    await ctx.reply(`🎤 ${htmlEscape(prompt)}`, { parse_mode: "HTML" }).catch(() => {});

    if (this.piStreaming) {
      dbg(1, `pi busy, steering voice message`);
      await ctx.react("👀");
      void this.steerPi(ctx.chatId, prompt, api);
      return;
    }

    void this.startPiSession(ctx.chatId, prompt, api);
  }
}

// ============================================================
// Telegram bot wiring & start (only when run as main)
// ============================================================

if (import.meta.main) {
  (async () => {
  if (!TOKEN) {
    console.error("FATAL: TELEGRAM_BOT_TOKEN not set");
    process.exit(1);
  }

  const bot = new Bot(TOKEN);

  dbg(1, `PI_PATH=${PI_PATH}`);
  dbg(1, `allowedUserId=${allowedUserId}`);

  const gateway = new Gateway({ allowedUserId, api: bot.api, botToken: TOKEN });

  function spawnPi(): void {
    const args = ["--mode", "rpc"];

    // pass-through args after --
    const dashDash = process.argv.indexOf("--");
    if (dashDash !== -1) args.push(...process.argv.slice(dashDash + 1));

    dbg(1, `spawning pi: ${PI_PATH} ${args.join(" ")}`);

    gateway.piClient = createPiClient({
      path: PI_PATH,
      args,
      env: process.env,
      onEvent: gateway.handlePiEvent,
      onLine: (line) => dbg(3, `pi stdout: ${line}`),
      onStderr: (data) => process.stderr.write(`[pi] ${data}`),
      onExit: (code) => {
        gateway.piStreaming = false;
        gateway.currentRelay = null;
        console.error(`[pi] exited (code=${code}). Restarting in 1s...`);
        setTimeout(spawnPi, 1000);
      },
      onError: (err) => {
        gateway.piStreaming = false;
        gateway.currentRelay = null;
        console.error(`[pi] spawn error: ${err.message}`);
        setTimeout(spawnPi, 1000);
      },
    });

    dbg(1, `pi pid=${gateway.piClient.pid}`);
  }

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 Send a message to talk to pi.");
  });

  // All handlers below require auth — enforced by this filter
  bot.filter((ctx) => ctx.from?.id === allowedUserId);

  // Handlers that talk to pi fire gateway.cmd*() with `void` — see the
  // "Slash command handlers" section of Gateway.
  bot.command("new", (ctx) => {
    dbg(1, "/new");
    void gateway.cmdNew(ctx.chatId);
  });

  bot.command("abort", (ctx) => {
    dbg(1, "/abort");
    void gateway.abortPi(ctx.chatId);
  });

  bot.command("abort_bash", (ctx) => {
    dbg(1, "/abort_bash");
    void gateway.cmdAbortBash(ctx.chatId);
  });

  bot.command("status", async (ctx) => {
    dbg(1, "/status");
    await gateway.showDaemonStatus(ctx.chatId);
  });

  bot.command("session", (ctx) => {
    dbg(1, "/session");
    void gateway.cmdSession(ctx.chatId);
  });

  bot.command("last", (ctx) => {
    dbg(1, "/last");
    void gateway.cmdLast(ctx.chatId);
  });

  bot.command("name", async (ctx) => {
    dbg(1, "/name");
    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply("ℹ️ Usage: /name <name>");
      return;
    }
    void gateway.cmdName(ctx.chatId, name);
  });

  bot.command("delete", (ctx) => {
    dbg(1, "/delete");
    void gateway.cmdDelete(ctx.chatId);
  });

  bot.command("resume", async (ctx) => {
    dbg(1, "/resume");
    const sessions = gateway.scanRecentSessions();

    if (sessions.length === 0) {
      await ctx.reply("📭 No previous sessions found.");
      return;
    }

    const kb = new InlineKeyboard();
    for (const s of sessions) {
      const label = s.name
        ? `${formatSessionDate(s.created)} - ${s.name}`
        : `${formatSessionDate(s.created)} - ${s.id.slice(-12)}`;
      kb.text(label, `resume:${s.id}`).row();
    }

    await ctx.reply("📋 Resume a session:", { reply_markup: kb });
  });

  bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {

    const sessionId = ctx.match?.[1];
    if (!sessionId || !ctx.chat) return;

    const info = gateway.sessionPicker.get(sessionId);

    if (!info) {
      await ctx.answerCallbackQuery("⏰ Expired. Run /resume again.");
      return;
    }

    void gateway.switchToSession(ctx.chat.id, sessionId);
    await ctx.answerCallbackQuery("✅ Switched.");

    const label = info.name
      ? `${info.name}`
      : info.id.slice(-12);
    await ctx.editMessageText(
      `📋 Resumed session: ${formatSessionDate(info.created)} - ${label}`,
    );
  });

  bot.command("quit", async (ctx) => {
    dbg(1, "/quit");
    await ctx.reply("🫡 kklaw — station secured. Going dark.");
    process.exit(0);
  });

  bot.command("model", (ctx) => {
    dbg(1, "/model");
    void gateway.cmdModels(ctx.chatId, ctx.match?.trim() || undefined);
  });

  bot.command("think", (ctx) => {
    dbg(1, "/think");
    const level = ctx.match?.trim();
    if (level) void gateway.cmdSetThinkingLevel(ctx.chatId, level);
    else void gateway.cmdThinkingLevels(ctx.chatId);
  });

  bot.command("compact", (ctx) => {
    dbg(1, "/compact");
    void gateway.cmdCompact(ctx.chatId, ctx.match?.trim() || undefined);
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const data = ctx.match?.[1];
    if (!data) return;

    const slash = data.indexOf("/");
    if (slash === -1) return;
    const provider = data.slice(0, slash);
    const modelId = data.slice(slash + 1);

    await ctx.answerCallbackQuery(`🔄 ${provider}/${modelId}…`);
    void gateway.setModel(provider, modelId).then((text) =>
      ctx.editMessageText(text).catch((err: Error) =>
        console.error(`[telegram] model ack failed: ${err.message}`)));
  });

  bot.callbackQuery(/^think:(.+)$/, async (ctx) => {
    const level = ctx.match?.[1];
    if (!level || !ctx.chat) return;
    await ctx.answerCallbackQuery(`💭 ${level}…`);
    await ctx.editMessageText(`💭 Setting thinking level: ${level}…`);
    void gateway.cmdSetThinkingLevel(ctx.chat.id, level);
  });

  bot.on("message:text", async (ctx) => {
    await gateway.handleTextMessage(ctx as unknown as MessageContext, ctx.api);
  });

  bot.on("message:photo", async (ctx) => {
    // grammy context satisfies PhotoMessageContext (has photo[], optional caption)
    await gateway.handlePhotoMessage(ctx as unknown as PhotoMessageContext, ctx.api);
  });

  bot.on("message:document", async (ctx) => {
    // grammy context satisfies DocumentMessageContext (has document.file_id, document.mime_type, optional caption)
    await gateway.handleDocumentMessage(ctx as unknown as DocumentMessageContext, ctx.api);
  });

  bot.on("message:voice", async (ctx) => {
    // grammy context satisfies VoiceMessageContext (has voice.file_id, voice.mime_type, optional caption)
    await gateway.handleVoiceMessage(ctx as unknown as VoiceMessageContext, ctx.api);
  });

  // Clear any chat-scoped commands from other bots (chat-scope overrides global scope)
  const chatScoped = await bot.api.getMyCommands({
    scope: { type: "chat", chat_id: allowedUserId },
  });
  if (chatScoped.length > 0) {
    await bot.api.deleteMyCommands({
      scope: { type: "chat", chat_id: allowedUserId },
    });
    console.error("[cmd] cleared stale chat-scoped commands:", chatScoped.map(c => c.command));
  }

  await bot.api.setMyCommands([
    { command: "resume",    description: "Switch to a previous session" },
    { command: "last",      description: "Show last assistant response text" },
    { command: "new",       description: "Start a new session" },
    { command: "delete",    description: "Delete the current session and start a new one" },
    { command: "abort",     description: "Abort the current agent turn" },
    { command: "abort_bash",description: "Abort the running bash command" },
    { command: "status",    description: "Show daemon status (uptime, Pi state)" },
    { command: "session",   description: "Show session state (model, messages, thinking)" },
    { command: "name",      description: "Set a display name for the current session" },
    { command: "quit",      description: "Exit the daemon" },
    { command: "model",     description: "List / filter available models, or switch model" },
    { command: "think",     description: "List / set thinking level (off..max)" },
    { command: "compact",   description: "Compact conversation context to reduce token usage" },
  ]).catch((err: Error) => {
    console.error(`[cmd] setMyCommands failed: ${err.message}`);
  });


  const UPLOAD_DIR = uploadDir();
  if (UPLOAD_DIR) {
    await mkdir(UPLOAD_DIR, { recursive: true });
    dbg(1, `upload dir ensured: ${UPLOAD_DIR}`);
  }

  spawnPi();
  void gateway.cmdState(allowedUserId);
  bot.api.sendMessage(allowedUserId, "🫡 kklaw — station green. Ready for tasking.").catch((err: Error) =>
    console.error(`[telegram] welcome send failed: ${err.message}`),
  );

  const watcher = new InjectWatcher(INJECT_DIR, (text, filename) => gateway.injectPrompt(text, filename));
  watcher.start();
  dbg(1, `inject watcher started dir=${INJECT_DIR}`);

  bot.api.config.use((prev, method, payload, signal) => {
    if (method === "sendMessage" || method === "editMessageText") {
      (payload as { link_preview_options?: { is_disabled?: boolean } }).link_preview_options = { is_disabled: true };
    }
    return prev(method, payload, signal);
  });

  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("kklaw gateway started"),
  });
  })();
}
