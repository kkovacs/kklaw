import { Bot } from "grammy";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

// ============================================================
// Config (loaded from .env by Bun auto)
// ============================================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const PI_PATH = (process.env.PI_PATH ?? "pi").replace(/^~/, homedir());
const PI_PROVIDER = process.env.PI_PROVIDER ?? "opencode";
const PI_MODEL = process.env.PI_MODEL; // optional; pi picks its default

// Verbosity: -v = events/states, -vv = also full JSON
const verbosity = process.argv.includes("-vv") ? 2 : process.argv.includes("-v") ? 1 : 0;
function dbg(level: 1 | 2, msg: string): void {
  if (verbosity >= level) console.error(msg);
}

dbg(1, `PI_PATH=${PI_PATH} PI_PROVIDER=${PI_PROVIDER} PI_MODEL=${PI_MODEL ?? "(default)"}`);

const allowedUserId = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID ?? "", 10);
dbg(1, `allowedUserId=${allowedUserId}`);

// ============================================================
// JSONL Framer (pi stdin/stdout protocol)
// Splits only on \n — Node's readline splits on Unicode sep. too
// ============================================================

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
}

// ============================================================
// Pi RPC subprocess
// ============================================================

const bot = new Bot(TOKEN);
let piProc: ChildProcess | null = null;
let piStreaming = false;

function spawnPi(): void {
  const args = ["--mode", "rpc", "--no-session", "--provider", PI_PROVIDER];
  if (PI_MODEL) args.push("--model", PI_MODEL);

  dbg(1, `spawning pi: ${PI_PATH} ${args.join(" ")}`);

  piProc = spawn(PI_PATH, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  dbg(1, `pi pid=${piProc.pid}`);

  piProc.stderr?.on("data", (data: Buffer | string) => {
    process.stderr.write(`[pi] ${data}`);
  });

  piProc.on("exit", (code: number | null) => {
    piStreaming = false;
    piProc = null;
    console.error(`[pi] exited (code=${code}). Restarting in 1s...`);
    setTimeout(spawnPi, 1000);
  });

  attachJsonlReader(piProc.stdout!, (line: string) => {
    dbg(2, `pi stdout: ${line}`);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      dbg(2, `pi unparsable line: ${line}`);
      return;
    }
    handlePiEvent(event as PiEvent | PiResponse);
  });
}

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

function sendPi(cmd: Record<string, unknown>): void {
  if (!piProc?.stdin) {
    console.error("[pi] cannot send command: pi not running");
    return;
  }
  const raw = JSON.stringify(cmd);
  dbg(2, `sendPi: ${raw}`);
  piProc.stdin.write(raw + "\n");
}

// ============================================================
// Streaming relay: pi text_delta → Telegram message edits
// ============================================================

const DEBOUNCE_MS = 600;

let currentChatId: number | string | null = null;
let currentMessageId: number | null = null;
let replyBuffer = "";
let editTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEdit(): void {
  if (editTimer) return;
  dbg(1, `scheduling edit in ${DEBOUNCE_MS}ms (buffer=${replyBuffer.length})`);
  editTimer = setTimeout(() => {
    editTimer = null;
    if (currentChatId === null || currentMessageId === null || !replyBuffer) return;
    dbg(1, `editMessageText chat=${currentChatId} msg=${currentMessageId} len=${replyBuffer.length}`);
    bot.api
      .editMessageText(currentChatId, currentMessageId, replyBuffer)
      .catch((err: Error) =>
        console.error(`[telegram] edit failed: ${err.message}`),
      );
  }, DEBOUNCE_MS);
}

async function finalizeReply(): Promise<void> {
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
  }
  if (currentChatId === null || currentMessageId === null || !replyBuffer) {
    dbg(1, "finalizeReply: no state to finalize");
    return;
  }

  dbg(1, `final edit chat=${currentChatId} msg=${currentMessageId} len=${replyBuffer.length}`);

  await bot.api
    .editMessageText(currentChatId, currentMessageId, replyBuffer)
    .catch((err: Error) =>
      console.error(`[telegram] final edit failed: ${err.message}`),
    );

  currentChatId = null;
  currentMessageId = null;
  replyBuffer = "";
}

// ============================================================
// Pi event handler
// ============================================================

function handlePiEvent(event: PiEvent | PiResponse): void {
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
      replyBuffer += delta.delta;
      scheduleEdit();
    }
    return;
  }

  if (type === "agent_end") {
    dbg(1, `agent_end, replyBuffer length=${replyBuffer.length}`);
    piStreaming = false;
    finalizeReply().then(() => processQueue());
    return;
  }

  // XXX: other events not handled yet (tool_execution, extension_ui, etc.)
  dbg(1, `unhandled pi event type: ${type}`);
}

// ============================================================
// Message queue — when pi is busy, queue and process later
// ============================================================

interface QueuedMessage {
  chatId: number | string;
  text: string;
}

const queue: QueuedMessage[] = [];

async function startPiSession(
  chatId: number | string,
  text: string,
): Promise<void> {
  dbg(1, `startPiSession chat=${chatId} text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
  piStreaming = true;
  currentChatId = chatId;

  const placeholder = await bot.api.sendMessage(chatId, "...");
  currentMessageId = placeholder.message_id;

  sendPi({ type: "prompt", message: text });
}

function processQueue(): void {
  dbg(1, `processQueue: piStreaming=${piStreaming} queue.length=${queue.length}`);
  if (piStreaming) return;
  const next = queue.shift();
  if (!next) return;
  startPiSession(next.chatId, next.text);
}

// ============================================================
// Telegram message handlers
// ============================================================

bot.command("start", async (ctx) => {
  await ctx.reply("Send a message to talk to pi.");
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  dbg(1, `message:text from user=${userId} chat=${ctx.chatId} text="${ctx.msg.text?.slice(0, 80)}"`);

  if (userId === undefined || userId !== allowedUserId) {
    dbg(1, `rejected user ${userId} (allowed: ${allowedUserId})`);
    return;
  }

  const text = ctx.msg.text;
  if (!text || text.startsWith("/")) return;

  if (piStreaming) {
    dbg(1, `pi busy, queuing message (queue.length=${queue.length})`);
    queue.push({ chatId: ctx.chatId, text });
    await ctx.reply("⏳ Queued.");
    return;
  }

  await startPiSession(ctx.chatId, text);
});

// ============================================================
// Start
// ============================================================

spawnPi();
bot.start({
  drop_pending_updates: true,
  onStart: () => console.log("kklaw gateway started"),
});
