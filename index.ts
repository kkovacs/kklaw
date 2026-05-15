import { Bot, InlineKeyboard } from "grammy";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { createRelay, escapeText, type Relay } from "./relay";
import { createPiClient, type PiClient } from "./pi-client";
import { scanSessions, formatSessionDate, type SessionInfo } from "./sessions";
import { createSafeEditor, formatToolCall, type TelegramApi, type MessageContext } from "./telegram";
import { InjectWatcher } from "./inject";

// ============================================================
// Config (loaded from .env by Bun auto)
// ============================================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PI_PATH = (process.env.PI_PATH ?? "pi").replace(/^~/, homedir());
const SESSION_DIR = (process.env.PI_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions")).replace(/^~/, homedir());
const INJECT_DIR = (process.env.TELEGRAM_INJECT_DIR ?? join(homedir(), ".pi", "agent", "injects")).replace(/^~/, homedir());

// Verbosity: -v = key events, -vv = + all event types, -vvv = + full JSON + raw pi lines
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

interface PiResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface PiEvent {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    reason?: string;
  };
  message?: {
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

interface ModelInfo {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

// ============================================================
// Gateway: all mutable state + business logic
// ============================================================

interface QueuedMessage {
  chatId: number | string;
  text: string;
}

export class Gateway {
  piClient: PiClient | null = null;
  piStreaming = false;
  queue: QueuedMessage[] = [];
  currentRelay: Relay | null = null;
  lastChatId: number | string = 0;
  currentChatId: number | string = 0;
  currentPlaceholderMessageId: number = 0;
  lastPiError?: string;
  turnToolCounts: Map<string, number> = new Map();
  showThinking = false;
  rawMode = false;
  lastTypingSent = 0;
  showTools = false;
  deleteRequestChatId: number | string = 0;
  sessionPicker: Map<string, SessionInfo> = new Map();
  modelFilter?: string;
  allowedUserId: number;
  api: TelegramApi;
  deleteFile: (path: string) => Promise<void> = unlink;
  startedAt = new Date();

  constructor(options: { allowedUserId: number; api: TelegramApi }) {
    this.allowedUserId = options.allowedUserId;
    this.api = options.api;
  }

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

    if (type !== "response" && type !== "agent_end" && this.currentChatId) {
      this.sendTyping(this.currentChatId);
    }

    if (type === "response") {
      const resp = event as PiResponse;
      if (!resp.success) {
        console.error(`[pi] error (${resp.command}): ${resp.error}`);
      } else {
        dbg(1, `pi response ok: ${resp.command}`);
        if (resp.command === "get_state" && this.lastChatId) {
          this.showStatus(this.lastChatId, resp.data);
        }
        if (resp.command === "get_state" && this.deleteRequestChatId) {
          const chatId = this.deleteRequestChatId;
          this.deleteRequestChatId = 0;
          const data = resp.data as { sessionId?: string; sessionFile?: string } | undefined;
          const sessionId = data?.sessionId;
          try {
            let info = sessionId ? this.sessionPicker.get(sessionId) : undefined;
            if (!info && sessionId) {
              this.scanRecentSessions();
              info = this.sessionPicker.get(sessionId);
            }
            if (info) {
              await this.deleteFile(info.path);
              dbg(1, `deleteSession: unlinked ${info.path}`);
            } else {
              console.error(`[delete] session ${sessionId ?? "?"} not found in picker; skipping unlink`);
            }
          } catch (err: any) {
            if (err?.code !== "ENOENT") {
              console.error(`[delete] unlink failed: ${err?.message ?? err}`);
            }
          }
          this.resetSession();
          this.sendPi({ type: "new_session" });
          try {
            await this.api.sendMessage(chatId, "🗑️ Session deleted. 🆕 New session started.");
          } catch (e) {
            console.error(`[delete] sendMessage failed: ${e}`);
          }
        }
        if (resp.command === "get_session_stats" && this.lastChatId) {
          this.showStats(this.lastChatId, resp.data);
        }
        if (resp.command === "get_last_assistant_text" && this.lastChatId) {
          this.showLastMessage(this.lastChatId, resp.data);
        }
        if (resp.command === "get_available_models" && this.lastChatId) {
          this.showModels(this.lastChatId, resp.data);
        }
      }
      return;
    }

    if (type === "message_update") {
      const delta = (event as PiEvent).assistantMessageEvent;
      if (delta?.type === "text_delta" && delta.delta) {
        this.currentRelay?.onDelta(delta.delta, 'text');
      } else if (delta?.type === "thinking_delta" && delta.delta) {
        if (this.showThinking) {
          this.currentRelay?.onDelta(delta.delta, 'thinking');
        }
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

    if (type === "message_end") {
      const msg = (event as PiEvent).message;
      if (msg?.stopReason === "error" && msg.errorMessage) {
        console.error(`[pi] message error: ${msg.errorMessage}`);
        if (verbosity >= 1) {
          console.error(`[pi] error context: stopReason=${msg.stopReason}`);
        }
        this.lastPiError = msg.errorMessage;
      }
      return;
    }

    if (type === "agent_end") {
      dbg(1, `agent_end`);
      this.piStreaming = false;

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
      if (!hadContent && this.lastPiError && this.currentChatId && this.currentPlaceholderMessageId) {
        try {
          await this.api.editMessageText(
            this.currentChatId,
            this.currentPlaceholderMessageId,
            `❌ Error: ${this.lastPiError}`,
          );
        } catch (err) {
          console.error(`[telegram] error edit failed: ${err instanceof Error ? err.message : String(err)}`);
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
      this.currentChatId = 0;
      this.currentPlaceholderMessageId = 0;
      this.processQueue();
      return;
    }

    if (type === "tool_execution_start") {
      const e = event as PiEvent;
      const toolName = e.toolName;
      if (toolName && typeof toolName === 'string') {
        if (this.showTools && this.currentChatId) {
          const label = formatToolCall(e.args, toolName);
          this.api.sendMessage(this.currentChatId, label, { parse_mode: "HTML" })
            .catch((err: Error) => console.error(`[telegram] tool call msg failed: ${err.message}`));
        }
        this.turnToolCounts.set(toolName, (this.turnToolCounts.get(toolName) ?? 0) + 1);
      }
      return;
    }

    // XXX: other events not handled yet (extension_ui, etc.)
    dbg(1, `unhandled pi event type: ${type}`);
  };

  sendTyping(chatId: number | string): void {
    const now = Date.now();
    if (now - this.lastTypingSent < 4000) return;
    this.lastTypingSent = now;
    this.api.sendChatAction?.(chatId, "typing")?.catch(() => {});
  }

  sendPi(cmd: Record<string, unknown>): void {
    const raw = JSON.stringify(cmd);
    dbg(2, `sendPi: ${raw}`);
    this.piClient?.send(cmd);
  }

  async startPiSession(
    chatId: number | string,
    text: string,
    api: TelegramApi = this.api,
  ): Promise<void> {
    dbg(1, `startPiSession chat=${chatId} text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    this.piStreaming = true;
    this.currentChatId = chatId;
    this.lastPiError = undefined;

    const placeholder = await api.sendMessage(chatId, "...");
    this.currentPlaceholderMessageId = placeholder.message_id;

    const editor = createSafeEditor(api, chatId, this.currentPlaceholderMessageId, (msg) => dbg(1, msg), this.rawMode);

    this.currentRelay = createRelay({
      edit: (buf, isFinal) =>
        editor.edit(buf, isFinal).catch((err: Error) =>
          console.error(`[telegram] edit failed: ${err.message}`),
        ),
      rawMode: this.rawMode,
      log: (msg) => dbg(1, msg),
    });

    this.sendPi({ type: "prompt", message: text });
  }

  processQueue(api: TelegramApi = this.api): void {
    dbg(1, `processQueue: piStreaming=${this.piStreaming} queue.length=${this.queue.length}`);
    if (this.piStreaming) return;
    const next = this.queue.shift();
    if (!next) return;
    this.startPiSession(next.chatId, next.text, api);
  }

  resetSession(): void {
    dbg(1, "resetSession");
    this.currentRelay?.cancel();
    this.currentRelay = null;
    this.piStreaming = false;
    this.turnToolCounts.clear();
    this.queue = [];
    this.currentChatId = 0;
    this.currentPlaceholderMessageId = 0;
    this.lastPiError = undefined;
  }

  scanRecentSessions(limit: number = 8, sessionDir?: string): SessionInfo[] {
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

  switchToSession(sessionId: string): void {
    const info = this.sessionPicker.get(sessionId);
    if (!info) {
      console.error(`[gateway] switchToSession: session ${sessionId} not in picker`);
      return;
    }

    dbg(1, `switchToSession: ${info.id} -> ${info.path}`);
    this.resetSession();
    this.sendPi({ type: "switch_session", sessionPath: info.path });
  }

  async showStatus(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const model = s.model as { provider?: string; modelId?: string; id?: string } | undefined;
    const modelName = model
      ? `${model.provider ?? "?"}/${model.modelId ?? model.id ?? "?"}`
      : "?";

    const lines = [
      `🤖 Model:         ${modelName}`,
      `📋 Session:       ${s.sessionId ?? "?"}${s.sessionName ? ` ("${s.sessionName}")` : ""}`,
      `💬 Messages:      ${s.messageCount ?? 0}${s.pendingMessageCount ? ` (+${s.pendingMessageCount} pending)` : ""}`,
      `💭 Thinking:      ${s.thinkingLevel ?? "?"}`,
    ];
    if (s.sessionFile) lines.push(`📁 Session file:  ${s.sessionFile}`);
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStatus failed: ${err.message}`),
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
      `📋 Queue depth:  ${this.queue.length}`,
      `💭 Thinking:     ${this.showThinking ? "on" : "off"}`,
      `🔧 Show tools:   ${this.showTools ? "on" : "off"}`,
      `📝 Raw mode:     ${this.rawMode ? "on" : "off"}`,
    ];
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showDaemonStatus failed: ${err.message}`),
    );
  }

  formatForTelegram(rawText: string): { text: string; other?: Record<string, unknown> } {
    if (this.rawMode) return { text: rawText };
    return { text: escapeText(rawText), other: { parse_mode: "MarkdownV2" } };
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
    const msg = this.formatForTelegram(text);
    await this.api.sendMessage(chatId, msg.text, msg.other).catch((err: Error) =>
      console.error(`[telegram] showLastMessage failed: ${err.message}`),
    );
  }

  async showModels(chatId: number | string, data: unknown): Promise<void> {
    const d = data as { models?: ModelInfo[] } | undefined;
    const models = d?.models ?? [];

    if (this.modelFilter) {
      const filter = this.modelFilter.toLowerCase();
      const matches = models.filter(m =>
        (m.name ?? "").toLowerCase().includes(filter) ||
        (m.id ?? "").toLowerCase().includes(filter)
      );
      this.modelFilter = undefined;

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
        const name = m.name ?? m.id ?? "?";
        lines.push(`${m.provider}/${m.id} — ${name}`);
        lines.push(`  ${modStr}  ${costStr}  ${ctx}`);
      }
      const maxLen = 3900;
      const tagOverhead = 11; // <pre></pre>
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
            const add = lines[end].length + 1;
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

  async showStats(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const tokens = s.tokens as Record<string, number> | undefined;
    const tok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

    const lines = [
      `📋 Session:       ${s.sessionId ?? "?"}`,
      `💬 Total messages: ${s.totalMessages ?? 0} (user: ${s.userMessages ?? 0}, assistant: ${s.assistantMessages ?? 0})`,
      `🔧 Tool calls:    ${s.toolCalls ?? 0} / results: ${s.toolResults ?? 0}`,
      `📥 Tokens in:     ${tokens ? tok(tokens.input) : "?"}`,
      `📤 Tokens out:    ${tokens ? tok(tokens.output) : "?"}`,
      `💾 Tokens cache:  ${tokens ? `r:${tok(tokens.cacheRead)} w:${tok(tokens.cacheWrite)}` : "?"}`,
      `📊 Tokens total:  ${tokens ? tok(tokens.total) : "?"}`,
      `💰 Cost:          $${s.cost != null ? Number(s.cost).toFixed(4) : "?"}`,
    ];
    if (s.sessionFile) lines.push(`📁 Session file:  ${s.sessionFile}`);
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStats failed: ${err.message}`),
    );
  }

  injectPrompt(text: string, filename: string): void {
    const chatId = this.currentChatId || this.allowedUserId;
    dbg(1, `injectPrompt file=${filename} chat=${chatId} text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    if (this.piStreaming) {
      dbg(1, `pi busy, queuing injected prompt (queue.length=${this.queue.length})`);
      this.queue.push({ chatId, text });
      return;
    }

    this.startPiSession(chatId, text);
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

    if (this.piStreaming) {
      dbg(1, `pi busy, queuing message (queue.length=${this.queue.length})`);
      this.queue.push({ chatId: ctx.chatId, text });
      await ctx.reply("⏳ Queued.");
      return;
    }

    await this.startPiSession(ctx.chatId, text, api);
  }
}

// ============================================================
// Telegram bot wiring & start (only when run as main)
// ============================================================

if (import.meta.main) {
  if (!TOKEN) {
    console.error("FATAL: TELEGRAM_BOT_TOKEN not set");
    process.exit(1);
  }

  const bot = new Bot(TOKEN);

  dbg(1, `PI_PATH=${PI_PATH}`);
  dbg(1, `allowedUserId=${allowedUserId}`);

  const gateway = new Gateway({ allowedUserId, api: bot.api });

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
        console.error(`[pi] spawn error: ${err.message}`);
        setTimeout(spawnPi, 1000);
      },
    });

    dbg(1, `pi pid=${gateway.piClient.pid}`);
  }

  bot.command("start", async (ctx) => {
    await ctx.reply("👋 Send a message to talk to pi.");
  });

  bot.command("new", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.resetSession();
    gateway.sendPi({ type: "new_session" });
    await ctx.reply("🆕 New session.");
  });

  bot.command("status", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    await gateway.showDaemonStatus(ctx.chatId);
  });

  bot.command("session", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.lastChatId = ctx.chatId;
    gateway.sendPi({ type: "get_state" });
    gateway.sendPi({ type: "get_session_stats" });
  });

  bot.command("last", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.lastChatId = ctx.chatId;
    gateway.sendPi({ type: "get_last_assistant_text" });
  });

  bot.command("showthink", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    const kb = new InlineKeyboard()
      .text(gateway.showThinking ? "✅ Yes" : "Yes", "showthink:yes")
      .text(gateway.showThinking ? "No" : "✅ No", "showthink:no");
    await ctx.reply("💭 Show LLM thinking?", { reply_markup: kb });
  });

  bot.callbackQuery("showthink:yes", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.showThinking = true;
    await ctx.answerCallbackQuery("✅ Enabled.");
    const kb = new InlineKeyboard()
      .text("✅ Yes", "showthink:yes")
      .text("No", "showthink:no");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.callbackQuery("showthink:no", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.showThinking = false;
    await ctx.answerCallbackQuery("❌ Disabled.");
    const kb = new InlineKeyboard()
      .text("Yes", "showthink:yes")
      .text("✅ No", "showthink:no");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.command("showtools", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    const kb = new InlineKeyboard()
      .text(gateway.showTools ? "✅ On" : "On", "showtools:on")
      .text(gateway.showTools ? "Off" : "✅ Off", "showtools:off");
    await ctx.reply("🔧 Show tool calls?", { reply_markup: kb });
  });

  bot.callbackQuery("showtools:on", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.showTools = true;
    await ctx.answerCallbackQuery("✅ Enabled.");
    const kb = new InlineKeyboard()
      .text("✅ On", "showtools:on")
      .text("Off", "showtools:off");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.callbackQuery("showtools:off", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.showTools = false;
    await ctx.answerCallbackQuery("❌ Disabled.");
    const kb = new InlineKeyboard()
      .text("On", "showtools:on")
      .text("✅ Off", "showtools:off");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.command("showraw", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    const kb = new InlineKeyboard()
      .text(gateway.rawMode ? "✅ Raw" : "Raw", "showraw:on")
      .text(gateway.rawMode ? "MarkdownV2" : "✅ MarkdownV2", "showraw:off");
    await ctx.reply("📄 Output format:", { reply_markup: kb });
  });

  bot.callbackQuery("showraw:on", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.rawMode = true;
    await ctx.answerCallbackQuery("📄 Raw mode. No formatting.");
    const kb = new InlineKeyboard()
      .text("✅ Raw", "showraw:on")
      .text("MarkdownV2", "showraw:off");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.callbackQuery("showraw:off", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.rawMode = false;
    await ctx.answerCallbackQuery("📄 MarkdownV2 mode.");
    const kb = new InlineKeyboard()
      .text("Raw", "showraw:on")
      .text("✅ MarkdownV2", "showraw:off");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  });

  bot.command("name", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;

    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply("ℹ️ Usage: /name <name>");
      return;
    }

    gateway.sendPi({ type: "set_session_name", name });
    await ctx.reply("✏️ Named.");
  });

  bot.command("delete", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.deleteRequestChatId = ctx.chatId;
    gateway.sendPi({ type: "get_state" });
    await ctx.reply("🗑️ Deleting session...");
  });

  bot.command("resume", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;

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
    if (ctx.from?.id !== allowedUserId) return;

    const sessionId = ctx.match?.[1];
    if (!sessionId) return;

    const info = gateway.sessionPicker.get(sessionId);

    if (!info) {
      await ctx.answerCallbackQuery("⏰ Expired. Run /resume again.");
      return;
    }

    gateway.switchToSession(sessionId);
    await ctx.answerCallbackQuery("✅ Switched.");

    const label = info.name
      ? `${info.name}`
      : info.id.slice(-12);
    await ctx.editMessageText(
      `📋 Resumed session: ${formatSessionDate(info.created)} - ${label}`,
    );
  });

  bot.command("quit", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    await ctx.reply("👋 Bye!");
    process.exit(0);
  });

  bot.command("model", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    const filter = ctx.match?.trim();
    gateway.modelFilter = filter || undefined;
    gateway.lastChatId = ctx.chatId;
    gateway.sendPi({ type: "get_available_models" });
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    const data = ctx.match?.[1];
    if (!data) return;

    const slash = data.indexOf("/");
    if (slash === -1) return;
    const provider = data.slice(0, slash);
    const modelId = data.slice(slash + 1);

    gateway.sendPi({ type: "set_model", provider, modelId });
    await ctx.answerCallbackQuery(`✅ Switched to ${provider}/${modelId}.`);
    await ctx.editMessageText(`✅ Model: ${provider}/${modelId}`);
  });

  bot.on("message:text", async (ctx) => {
    await gateway.handleTextMessage(ctx, ctx.api);
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
    { command: "new",       description: "Start a new session" },
    { command: "status",    description: "Show daemon status (uptime, Pi state, queue)" },
    { command: "session",    description: "Show session state (model, messages, thinking)" },

    { command: "last",      description: "Show last assistant response text" },
    { command: "showthink", description: "Toggle thinking block visibility" },
    { command: "showtools", description: "Toggle live tool call messages" },
    { command: "showraw",  description: "Toggle raw/MarkdownV2 message formatting" },
    { command: "resume",    description: "Switch to a previous session" },
    { command: "delete",    description: "Delete the current session and start a new one" },
    { command: "name",      description: "Set a display name for the current session" },
    { command: "model",     description: "List / filter available models, or switch model" },
    { command: "quit",      description: "Exit the daemon" },
  ]);


  spawnPi();

  const watcher = new InjectWatcher(INJECT_DIR, (text, filename) => gateway.injectPrompt(text, filename));
  watcher.start();
  dbg(1, `inject watcher started dir=${INJECT_DIR}`);

  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("kklaw gateway started"),
  });
}
