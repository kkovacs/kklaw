# kklaw — Telegram ↔ Pi RPC Gateway

A bun project bridging Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

Source files: `index.ts` (bot wiring + `Gateway` class), `telegram.ts` (API utils, file download, safe editor), `relay.ts` (debounced streaming + formatting), `pi-client.ts` (subprocess + JSONL), `sessions.ts` (session scanning), `inject.ts` (file-based prompt injection).

## Pipeline

1. Telegram text/photo → auth check (`TELEGRAM_ALLOWED_USER_ID`). Known slash commands intercepted by `bot.command()`; unknown ones pass through as prompts. `!command` triggers a `bash` RPC (not a Pi LLM prompt). Photos: largest by `file_size` picked, downloaded via Telegram `getFile`, base64-encoded as `image/jpeg`.
2. If pi idle → send `{"type":"prompt"}` (with optional `images` for photos). While working, "typing..." sent reactively on each incoming event (with cooldown, excluding `response`/`agent_end`).
3. Pi streams `text_delta` + `thinking_delta` → relay accumulates, thinking wrapped in `> ` blockquote (MarkdownV2) → `createSafeEditor.edit()` debounced. `thinking_delta` is silently dropped when `showThinking` is off (filtered in `handlePiEvent`, not in relay).
4. On `agent_end` → final edit (or error placeholder if stream produced no content and Pi errored), tool summary, clear state, process next queued message.
5. If pi busy → message queued FIFO (in-memory), user gets "Queued." reply.

### File injection pipeline

External tool writes a file to the inject dir → `InjectWatcher.scan()` detects, reads, deletes it → `Gateway.injectPrompt()` → same pipeline as step 2 above. Responses stream to `currentChatId` (or fall back to `allowedUserId`).

## Slash commands

Commands use loose coupling: the handler stores a per-command chatId field (`lastChatId`, `bashRequestChatId`, `deleteRequestChatId`), fires the RPC; `handlePiEvent` response handler picks it up and posts to that chat. All commands (except `/start`) require auth via `bot.filter()`.

| Telegram command | RPC command | Response |
|------------------|-------------|----------|
| `/new` | `new_session` | cancels relay + resets state via `resetSession()` |
| `/session` | `get_state` + `get_session_stats` | `showStatus()` + `showStats()` — two `<pre>` HTML messages |
| `/last` | `get_last_assistant_text` | `showLastMessage()` with MarkdownV2 escaping (raw mode sends plain) |
| `/status` | (none) | `showDaemonStatus()` — uptime, Pi pid, streaming state, queue, toggles |
| `/showthink` | (none) | toggles `showThinking` via inline keyboard |
| `/showtools` | (none) | toggles `showTools` via inline keyboard; when On, sends `<pre>` per tool call with truncated args |
| `/showraw` | (none) | toggles `rawMode` (Raw / MarkdownV2) via inline keyboard; controls escaping + `parse_mode` |
| `/resume` | (none; filesystem scan) | scans session dir for recent `.jsonl` files, shows inline keyboard; button click fires `switch_session` RPC |
| `/name <name>` | `set_session_name` | sets display name on current session; `/name` alone shows usage |
| `/model [filter]` | `get_available_models` | no filter → `<pre>` list; filter → inline keyboard buttons firing `set_model` RPC |
| `/delete` | `get_state` → unlink → `new_session` | looks up session file in `sessionPicker` by `sessionId`, deletes it, resets + new session |
| `/quit` | (none) | replies "Bye" then `process.exit(0)` |
| `!command` | `bash` | stores `bashRequestChatId`, runs command via Pi bash RPC, returns output in `<pre>` chunks via response handler |

## Key design decisions

- **Gateway class** accepts injectable `TelegramApi` and download/delete functions — testable with mocks.
- **JSONL framer** is custom: Node's `readline` splits on `U+2028`/`U+2029` which are valid in JSON strings. Custom `\n`-only splitter with `\r` strip.
- **Debounced streaming**: buffer accumulates deltas, `editMessageText` fires on a timer, final edit on `agent_end`.
- **Reactive typing indicator**: `sendChatAction("typing")` fires on each incoming work event (with cooldown). No `setInterval`. Events like `response`/`agent_end` don't trigger it.
- **Thinking via blockquote**: `thinking_delta` events interleaved with `text_delta`. Relay wraps thinking in `> ` prefix (MarkdownV2 blockquote).
- **createSafeEditor** handles three error classes: `MESSAGE_TOO_LONG` (rollback + chunk-send), parse errors during streaming (skip, retry later), parse errors on final (plain text fallback). Blockquote continuation on split.
- **Dual MarkdownV2 escape**: thinking gets strict escape (all reserved chars); text gets relaxed escape (`*` `_` `` ` `` pass through for Pi's formatting). Other reserved chars always escaped.
- **Sequential processing**: Pi handles one prompt at a time. Queue is FIFO, in-memory.
- **Pi restart on crash**: `exit`/`error` handler spawns a new pi process after 1s delay.
- **Error bubbling**: Pi errors that produce no stream content surface to the Telegram user by editing the placeholder message.
- **Verbosity**: `-v` = key events/states + error context, `-vv` = + `sendPi` raw + telegram msg JSON, `-vvv` = + full event JSON + raw stdout lines. Pi errors always logged to stderr regardless.
- **drop_pending_updates: true** — avoids stale Telegram messages on restart.
- **Command registration via `setMyCommands`** — clears stale chat-scoped commands on startup, registers global commands so they appear in `/` autocomplete.
- **grammy handler ordering**: `bot.command()` handlers must be registered before `bot.on("message:text")` catch-all.

## Known gaps (marked `XXX` in code)

- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) not forwarded to user
- Message queue is in-memory — lost on gateway restart
- Unauthorized users are silently ignored (no rejection reply)
- `/resume` shows limited results; no pagination
- Photo media group debouncing not implemented
- Photo download has no size limit check
- Documents with `image/*` MIME types and stickers not handled (only `message:photo`)

## Pi/provider gotcha

Pi stores assistant `thinking` blocks with `thinkingSignature: "reasoning"` in session history. Providers using `openai-completions` API may reject those `reasoning` fields as extra inputs, producing `400 Error from provider`. The gateway surfaces this error to the user instead of leaving a frozen placeholder. A `/new` session clears the history as a workaround.

## Pi RPC types used

```
prompt:   { type: "prompt", message: string, images?: ImageContent[] }
bash:     { type: "bash", command: string }
response: { type: "response", command?: string, success: bool, error?: string, data?: unknown }
ImageContent: `{ type: "image", data: string (base64), mimeType: string }`
ModelInfo (subset used): `{ id, name, provider, contextWindow, input[], cost: { input, output } }`
```

## Configuration (`.env`)

Bun auto-loads `.env` from the project root (the directory containing `package.json`), not from CWD.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | — |
| `OPENCODE_API_KEY` | passed to pi subprocess via inherited env | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |
| `PI_SESSION_DIR` | root dir for session `.jsonl` scan | `~/.pi/agent/sessions/` |
| `TELEGRAM_INJECT_DIR` | directory watched for prompt files | `~/.pi/agent/injects/` |

Extra Pi flags passed after `--`:

```bash
bun run index.ts -- --provider opencode-go --model minimax-m2.5 --no-session
```

## Commands

```bash
bun install        # install dependencies
bun run index.ts   # start the gateway
bun test           # run tests
```
