import { Bot } from "grammy";
import { homedir } from "node:os";
import { createRelay, type Relay } from "./relay";
import { createPiClient, type PiClient } from "./pi-client";

// ============================================================
// Config (loaded from .env by Bun auto)
// ============================================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PI_PATH = (process.env.PI_PATH ?? "pi").replace(/^~/, homedir());

// Verbosity: -v = events/states, -vv = also full JSON
const verbosity = process.argv.includes("-vv") ? 2 : process.argv.includes("-v") ? 1 : 0;
function dbg(level: 1 | 2, msg: string): void {
  if (verbosity >= level) console.error(msg);
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
  };
}

// ============================================================
// Gateway: all mutable state + business logic
// ============================================================

export interface TelegramApi {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export interface MessageContext {
  chatId: number | string;
  from?: { id: number };
  msg: { text?: string };
  reply(text: string): Promise<unknown>;
}

interface QueuedMessage {
  chatId: number | string;
  text: string;
}

function createSafeEditor(
  api: TelegramApi,
  chatId: number | string,
  firstMessageId: number,
  log?: (msg: string) => void,
) {
  const messageIds: number[] = [firstMessageId];
  const lastGoodTexts: string[] = [""];
  let frozenLength = 0;

  function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function isNotModifiedError(err: unknown): boolean {
    return errMessage(err).includes("message is not modified");
  }

  function isParseError(err: unknown): boolean {
    const msg = errMessage(err).toLowerCase();
    return (
      msg.includes("can't parse entities") ||
      msg.includes("unsupported start tag") ||
      msg.includes("unexpected end tag") ||
      msg.includes("entity name expected") ||
      msg.includes("parse entities") ||
      msg.includes("can't parse message text")
    );
  }

  function isTooLongError(err: unknown): boolean {
    const msg = errMessage(err).toLowerCase();
    return msg.includes("message_too_long") || msg.includes("message is too long");
  }

  function splitTelegramText(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let cut = remaining.lastIndexOf("\n", maxLen);
      if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
      if (cut < maxLen * 0.5) cut = maxLen;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.length > 0 ? chunks : [""];
  }

  async function rollbackLastMessage(messageId: number, goodText: string): Promise<void> {
    try {
      await api.editMessageText(chatId, messageId, goodText, { parse_mode: "MarkdownV2" });
    } catch (err) {
      if (isNotModifiedError(err)) return;
      if (isParseError(err)) {
        try {
          await api.editMessageText(chatId, messageId, goodText);
        } catch (plainErr) {
          if (!isNotModifiedError(plainErr)) {
            log?.(`[telegram] plain rollback edit failed: ${errMessage(plainErr)}`);
          }
        }
        return;
      }
      log?.(`[telegram] rollback edit failed: ${errMessage(err)}`);
    }
  }

  async function sendChunk(text: string, parseMode: boolean): Promise<{ message_id: number }> {
    try {
      if (parseMode) {
        return await api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
      }
      return await api.sendMessage(chatId, text);
    } catch (err) {
      if (parseMode && isParseError(err)) {
        return await api.sendMessage(chatId, text);
      }
      throw err;
    }
  }

  return {
    async edit(fullText: string, isFinal?: boolean): Promise<void> {
      const candidate = fullText.slice(frozenLength);
      const lastIndex = messageIds.length - 1;
      const lastMessageId = messageIds[lastIndex];

      try {
        await api.editMessageText(chatId, lastMessageId, candidate, { parse_mode: "MarkdownV2" });
        lastGoodTexts[lastIndex] = candidate;
      } catch (err) {
        if (isNotModifiedError(err)) {
          return;
        }

        if (isTooLongError(err)) {
          const goodText = lastGoodTexts[lastIndex];
          if (goodText && goodText !== candidate) {
            await rollbackLastMessage(lastMessageId, goodText);
          }

          const remainder = candidate.slice(goodText.length);
          if (!remainder) return;

          let textToChunk = remainder;
          if (goodText && !goodText.endsWith('\n')) {
            const lastNewline = goodText.lastIndexOf('\n');
            const lastLine = lastNewline >= 0 ? goodText.slice(lastNewline + 1) : goodText;
            if (lastLine.startsWith('>') && !remainder.startsWith('>')) {
              textToChunk = '> ' + remainder;
            }
          }

          const chunks = splitTelegramText(textToChunk, 4000);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLastChunk = i === chunks.length - 1;
            try {
              const sent = await sendChunk(chunk, true);
              messageIds.push(sent.message_id);
              lastGoodTexts.push(chunk);
              if (!isLastChunk) {
                frozenLength += chunk.length;
              }
            } catch (sendErr) {
              log?.(`[telegram] send chunk failed: ${errMessage(sendErr)}`);
              throw sendErr;
            }
          }

          frozenLength += goodText.length;
          return;
        }

        if (isParseError(err)) {
          if (isFinal) {
            try {
              await api.editMessageText(chatId, lastMessageId, candidate);
            } catch (fallbackErr) {
              log?.(`[telegram] plain fallback edit failed: ${errMessage(fallbackErr)}`);
            }
          } else {
            log?.(`[telegram] parse error during streaming, will retry later: ${errMessage(err)}`);
          }
          return;
        }

        log?.(`[telegram] edit failed: ${errMessage(err)}`);
      }
    },
  };
}

export class Gateway {
  piClient: PiClient | null = null;
  piStreaming = false;
  queue: QueuedMessage[] = [];
  currentRelay: Relay | null = null;
  lastChatId: number | string = 0;
  allowedUserId: number;
  api: TelegramApi;

  constructor(options: { allowedUserId: number; api: TelegramApi }) {
    this.allowedUserId = options.allowedUserId;
    this.api = options.api;
  }

  handlePiEvent = (event: PiEvent | PiResponse): void => {
    const type = event.type;
    dbg(1, `pi event type=${type}`);

    if (type === "response") {
      const resp = event as PiResponse;
      if (!resp.success) {
        console.error(`[pi] error (${resp.command}): ${resp.error}`);
      } else {
        dbg(1, `pi response ok: ${resp.command}`);
        if (resp.command === "get_state" && this.lastChatId) {
          this.showStatus(this.lastChatId, resp.data);
        }
        if (resp.command === "get_session_stats" && this.lastChatId) {
          this.showStats(this.lastChatId, resp.data);
        }
      }
      return;
    }

    if (type === "message_update") {
      const delta = (event as PiEvent).assistantMessageEvent;
      if (delta?.type === "text_delta" && delta.delta) {
        this.currentRelay?.onDelta(delta.delta, 'text');
      } else if (delta?.type === "thinking_delta" && delta.delta) {
        this.currentRelay?.onDelta(delta.delta, 'thinking');
      }
      return;
    }

    if (type === "agent_end") {
      dbg(1, `agent_end`);
      this.piStreaming = false;
      this.currentRelay?.onDone().then(() => {
        this.currentRelay = null;
        this.processQueue();
      });
      return;
    }

    // XXX: other events not handled yet (tool_execution, extension_ui, etc.)
    dbg(1, `unhandled pi event type: ${type}`);
  };

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

    const placeholder = await api.sendMessage(chatId, "...");
    const messageId = placeholder.message_id;

    const editor = createSafeEditor(api, chatId, messageId, (msg) => dbg(1, msg));

    this.currentRelay = createRelay({
      edit: (buf, isFinal) =>
        editor.edit(buf, isFinal).catch((err: Error) =>
          console.error(`[telegram] edit failed: ${err.message}`),
        ),
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
    this.queue = [];
  }

  async showStatus(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const model = s.model as { provider?: string; modelId?: string; id?: string } | undefined;
    const modelName = model
      ? `${model.provider ?? "?"}/${model.modelId ?? model.id ?? "?"}`
      : "?";

    const lines = [
      `Model:         ${modelName}`,
      `Session:       ${s.sessionId ?? "?"}${s.sessionName ? ` ("${s.sessionName}")` : ""}`,
      `Messages:      ${s.messageCount ?? 0}${s.pendingMessageCount ? ` (+${s.pendingMessageCount} pending)` : ""}`,
      `Thinking:      ${s.thinkingLevel ?? "?"}`,
    ];
    if (s.sessionFile) lines.push(`Session file:  ${s.sessionFile}`);
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStatus failed: ${err.message}`),
    );
  }

  async showStats(chatId: number | string, data: unknown): Promise<void> {
    const s = data as Record<string, unknown> | undefined;
    if (!s) return;

    const tokens = s.tokens as Record<string, number> | undefined;
    const tok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

    const lines = [
      `Session:       ${s.sessionId ?? "?"}`,
      `Total messages: ${s.totalMessages ?? 0} (user: ${s.userMessages ?? 0}, assistant: ${s.assistantMessages ?? 0})`,
      `Tool calls:    ${s.toolCalls ?? 0} / results: ${s.toolResults ?? 0}`,
      `Tokens in:     ${tokens ? tok(tokens.input) : "?"}`,
      `Tokens out:    ${tokens ? tok(tokens.output) : "?"}`,
      `Tokens cache:  ${tokens ? `r:${tok(tokens.cacheRead)} w:${tok(tokens.cacheWrite)}` : "?"}`,
      `Tokens total:  ${tokens ? tok(tokens.total) : "?"}`,
      `Cost:          $${s.cost != null ? Number(s.cost).toFixed(4) : "?"}`,
    ];
    if (s.sessionFile) lines.push(`Session file:  ${s.sessionFile}`);
    const text = `<pre>${lines.join("\n")}</pre>`;
    await this.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err: Error) =>
      console.error(`[telegram] showStats failed: ${err.message}`),
    );
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
    if (!text || text.startsWith("/")) return;

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
      onLine: (line) => dbg(2, `pi stdout: ${line}`),
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
    await ctx.reply("Send a message to talk to pi.");
  });

  bot.command("new", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.resetSession();
    gateway.sendPi({ type: "new_session" });
    await ctx.reply("New session.");
  });

  bot.command("status", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.lastChatId = ctx.chatId;
    gateway.sendPi({ type: "get_state" });
  });

  bot.command("context", async (ctx) => {
    if (ctx.from?.id !== allowedUserId) return;
    gateway.lastChatId = ctx.chatId;
    gateway.sendPi({ type: "get_session_stats" });
  });

  bot.on("message:text", async (ctx) => {
    await gateway.handleTextMessage(ctx, ctx.api);
  });

  spawnPi();
  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("kklaw gateway started"),
  });
}
