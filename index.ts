import { Bot } from "grammy";
import { homedir } from "node:os";
import { createRelay, type Relay } from "./relay";
import { createPiClient, type PiClient } from "./pi-client";

// ============================================================
// Config (loaded from .env by Bun auto)
// ============================================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PI_PATH = (process.env.PI_PATH ?? "pi").replace(/^~/, homedir());
const PI_PROVIDER = process.env.PI_PROVIDER ?? "opencode";
const PI_MODEL = process.env.PI_MODEL; // optional; pi picks its default

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
  sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }>;
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

export class Gateway {
  piClient: PiClient | null = null;
  piStreaming = false;
  queue: QueuedMessage[] = [];
  currentRelay: Relay | null = null;
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

    this.currentRelay = createRelay({
      edit: (buf, entities) =>
        api.editMessageText(chatId, messageId, buf, entities ? { entities } : {}).catch((err: Error) =>
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

  dbg(1, `PI_PATH=${PI_PATH} PI_PROVIDER=${PI_PROVIDER} PI_MODEL=${PI_MODEL ?? "(default)"}`);
  dbg(1, `allowedUserId=${allowedUserId}`);

  const gateway = new Gateway({ allowedUserId, api: bot.api });

  function spawnPi(): void {
    const args = ["--mode", "rpc", "--no-session", "--provider", PI_PROVIDER];
    if (PI_MODEL) args.push("--model", PI_MODEL);

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

  bot.on("message:text", async (ctx) => {
    await gateway.handleTextMessage(ctx, ctx.api);
  });

  spawnPi();
  bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("kklaw gateway started"),
  });
}
