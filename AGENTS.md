# kklaw — Telegram ↔ Pi RPC Gateway

A [bun](https://bun.com) project that bridges Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

Four files: `index.ts` (bot wiring + `Gateway` + `createSafeEditor`), `sessions.ts` (session file scanning), `relay.ts` (debounced streaming + formatting), `pi-client.ts` (subprocess + JSONL). Extracted for testability.

### Pipeline

1. Telegram user sends a text message or slash command
2. grammy `message:text` handler checks `TELEGRAM_ALLOWED_USER_ID`
3. If pi is idle → spawn placeholder `"..."` message, send `{"type":"prompt"}` to pi. While pi is working, a "typing..." indicator is sent to Telegram reactively (on each incoming Pi event, with 4s cooldown to avoid rate limits). Stops naturally when events stop arriving (~5s Telegram expiry).
4. pi streams `message_update` events (`text_delta` + `thinking_delta`) → relay accumulates segments, thinking wrapped in `> ` blockquote (MarkdownV2) → `createSafeEditor.edit()` debounced at 600ms
5. On `agent_end` → final relay edit (or error placeholder), send `"🔧 N tools used: bash ×3, read"` summary if any `tool_execution_start` events were counted during the run, clear state, process next queued message. **If the stream produced no content and Pi reported an error, the placeholder is edited to `Error: <message>` so the user is not left with a frozen "...".**
6. If pi is busy → message goes to an in-memory queue, user gets "Queued." reply

#### Slash commands (Telegram → Pi RPC)

Commands use a **loose coupling** pattern: the command handler stores `lastChatId`, fires the RPC command; the `handlePiEvent` response handler picks it up and posts to that chat. Single user, single connection, no promise plumbing.

| Telegram command | RPC command | Response handler |
|------------------|-------------|------------------|
| `/new` | `new_session` | logs response; also cancels relay + resets state via `resetSession()` |
| `/status` | `get_state` | `showStatus()` → formats into `<pre>` HTML block |
| `/context` | `get_session_stats` | `showStats()` → formats token counts (K/M) + cost into `<pre>` HTML block |
| `/last` | `get_last_assistant_text` | `showLastMessage()` → sends last assistant text with MarkdownV2 escaping (via `formatForTelegram()`); raw mode sends plain |
| `/showthink` | (none) | toggles `showThinking` via inline keyboard (Yes/No) |
| `/showtools` | (none) | toggles `showTools` via inline keyboard (On/Off); when On, sends a `<pre>` HTML message per tool call with truncated `JSON.stringify(args)` |
| `/showraw` | (none) | toggles `rawMode` via inline keyboard (Raw / MarkdownV2); controls escaping + `parse_mode` for streaming and `/last` |
| `/resume` | (none; filesystem scan) | scans `~/.pi/agent/sessions/` for recent `.jsonl` session files, shows inline keyboard |
| `/name <name>` | `set_session_name` | sets display name on current session; `/name` alone shows usage |
| `/delete` | `get_state` → `unlink` → `new_session` | async: sends `get_state`, finds session file in `sessionPicker` by `sessionId`, deletes the `.jsonl` file via `fs.unlink`, calls `resetSession()` + `new_session`, replies "Session deleted. New session started." Falls back gracefully if session not found or file is missing.

### Key design decisions

- **Separated for testability**: `relay.ts` (pure debounce logic), `pi-client.ts` (I/O boundary), `index.ts` (`Gateway` class + wiring). Extracted only when testing became the goal.
- **Testable core**: `Gateway` class accepts `TelegramApi` and `PiClient` as injectable deps. Tests use mock APIs, no real Telegram or pi needed.
- **JSONL framer is custom**: Node's `readline` is incompatible (splits on `U+2028`/`U+2029` which are valid in JSON strings). Custom `\n`-only splitter with optional `\r` strip.
- **Debounced streaming**: editing Telegram messages per-character would hit rate limits. Buffer accumulates deltas, `editMessageText` fires every 600ms, final edit on `agent_end`.
- **Reactive typing indicator**: `sendChatAction("typing")` fires on each incoming Pi event that means work is happening (`text_delta`, `thinking_delta`, `tool_execution_start`, etc.), with a 4s cooldown. No `setInterval` — the indicator is driven by real events and naturally expires ~5s after Pi goes silent. Events like `response` and `agent_end` do not trigger it.
- **Thinking via blockquote**: `thinking_delta` events are streamed alongside `text_delta`. The relay interleaves segments, wrapping thinking content in `> ` prefix (MarkdownV2 blockquote) with special characters escaped.
- **Robust Telegram editing (`createSafeEditor`)**: sits between `relay.ts` and the Telegram API. Handles three error classes:
  - `MESSAGE_TOO_LONG` (4000 char limit) → rolls back to the last known good text, then `sendMessage`s the remainder in ≤4000-char chunks. Earlier chunks are "frozen"; streaming continues on the newest chunk.
  - Parse errors during streaming (`!isFinal`) → skipped silently; `lastGoodTexts` is not updated. The next debounced edit retries with more text, which may complete broken markdown.
  - Parse errors on final (`isFinal=true`) → falls back to plain text (no `parse_mode`) on the last message so the user at least sees raw text.
  - Blockquote continuation: if `MESSAGE_TOO_LONG` splits mid-line inside a `>` blockquote, the remainder is prepended with `> ` so the new message continues the blockquote. This works because `relay.ts` escapes `>` in text segments, so any line starting with `>` is guaranteed to be thinking.
- **MarkdownV2 with dual escape**: the entire message is sent with `parse_mode: "MarkdownV2"`. Two escape levels:
  - **Thinking**: strict escape (all reserved chars) → no accidental formatting inside `> ` blockquotes
  - **Text**: relaxed escape (`*`, `_`, `` ` `` pass through) → Pi's `**bold**`, `*italic*`, `` `code` `` render
  - Other reserved chars (`!`, `.`, `[`, `]`, `~`, etc.) are always escaped to prevent parse errors (400 Bad Request)
- **Sequential processing**: pi handles one prompt at a time. Incoming messages while busy are queued FIFO.
- **Pi restart on crash**: `exit` handler spawns a new pi process after 1s delay.
- **Error bubbling**: Pi errors that produce no stream content are surfaced to the Telegram user by editing the placeholder message. Without this, the user sees a frozen `"..."` forever.
- **Verbosity levels**:
  - **No flag**: Pi errors always logged to stderr; nothing else.
  - **`-v`**: events/states + terse error context (`stopReason=error`, `messages=3`, etc.).
  - **`-vv`**: full JSON of every event (`[pi] event JSON: ...`) plus raw stdout lines (`pi stdout: ...`).
- **`drop_pending_updates: true`**: avoids processing stale Telegram messages on restart.
- **Command registration via `setMyCommands`**: on startup, clears any stale chat-scoped commands (e.g. from other bots sharing the same user), then registers global commands. Telegram precedence: chat-scope > default-scope — without cleanup, another bot's chat-scoped commands would hide kklaw's.

### Known gaps (marked `XXX` in code)

- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) not forwarded to user yet
- Message queue is in-memory only — lost on gateway restart
- Unauthorized users are silently ignored (no rejection reply)
- Other builtin slash commands (`/model`, `/compact`, `/fork`, `/clone`, etc.) not registered yet
- `/resume` shows only 8 most recent; no pagination

### Pi/provider gotcha

Pi stores assistant `thinking` blocks with `thinkingSignature: "reasoning"` in the session history. When sending the history to providers using the `openai-completions` API (e.g. `opencode-go` / `kimi-k2.6`), Pi includes those `reasoning` fields in the messages array. Some providers reject them as extra/unknown inputs, producing a `400 Error from provider: Extra inputs are not permitted, field: 'messages[N].reasoning'` and an empty assistant response. The gateway now surfaces this error to the user instead of leaving a frozen placeholder. A `/new` session clears the history and temporarily fixes it.

## Configuration (`.env`)

Bun auto-loads `.env` — no library needed.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** (crash if missing) |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | — (empty = no one) |
| `OPENCODE_API_KEY` | passed to pi subprocess via inherited env | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |
| `PI_SESSION_DIR` | root dir to scan for session `.jsonl` files | `~/.pi/agent/sessions/` |

Extra Pi flags (provider, model, no-session, etc.) are passed on the command line after `--`:

```bash
bun run index.ts -- --provider opencode-go --model minimax-m2.5 --no-session
```

## Commands

```bash
bun install        # install dependencies (grammy)
bun run index.ts   # start the gateway
bun test           # run tests
```

## File guide

### `index.ts`

**Config** — reads `TELEGRAM_BOT_TOKEN`, `PI_PATH`, `TELEGRAM_ALLOWED_USER_ID`, verbosity flags (`-v`, `-vv`). Additional Pi flags passed after `--` on command line.

**`Gateway` class** — all mutable state + business logic:

- `handleTextMessage(ctx, api?)` — grammy `message:text` handler logic. Checks `allowedUserId`, ignores `/` commands, enqueues or starts a pi session.
- `startPiSession(chatId, text, api?)` — sets `piStreaming = true`, sends "..." placeholder, creates a `createSafeEditor` + `Relay`, sends `{"type":"prompt",...}` to pi.
- `handlePiEvent(event)` — routes pi events (now `async` so it can `await relay.onDone()` before deciding whether to bubble an error):
  - `response` — log success/error; routes `get_state` → `showStatus()`, `get_session_stats` → `showStats()`, `get_last_assistant_text` → `showLastMessage()` when `lastChatId` is set. Also handles `/delete` flow when `deleteRequestChatId` is set: extracts `sessionId` from `get_state` response, looks up `SessionInfo.path` in `sessionPicker` (rescans only if not found), deletes the `.jsonl` file, then `resetSession()` + `new_session` + confirmation message.
  - `message_update` with `text_delta` → `relay.onDelta(delta, 'text')`
  - `message_update` with `thinking_delta` → `relay.onDelta(delta, 'thinking')`
  - `message_update` with `error` → logs to stderr immediately (always, even without `-v`)
  - `message_end` with `stopReason === "error"` → captures `errorMessage` for later
  - `tool_execution_start` → counts tool calls by `toolName` in `turnToolCounts` map (accumulated across all turns). If `showTools` is enabled, also formats and sends a `<pre>` HTML message with `JSON.stringify(args)` (truncated to 250 chars).
  - `agent_end` → `await relay.onDone()`. Sends tool summary message (`"🔧 N tools used: bash ×3, read"`) if any tools were counted. If relay produced no content and an error was captured, edits the placeholder message with the error text. Then `processQueue()`.
- `processQueue(api?)` — if pi idle, dequeues next message and calls `startPiSession`.
- `sendPi(cmd)` — JSON-stringifies and sends to `piClient`.
- `sendTyping(chatId)` — fires `sendChatAction("typing")` with 4s cooldown. Called reactively by `handlePiEvent` on events that mean Pi is working (not `response` or `agent_end`).
- `formatToolCall(args, toolName)` — exported pure function. Returns `<pre>🔧 name: {"key":"val"}</pre>` with HTML-escaped, 250-c truncated `JSON.stringify(args)`. Handles missing/falsy args gracefully.
- `htmlEscape(s)` — escapes `&`, `<`, `>` for HTML `parse_mode` messages.
- `resetSession()` — cancels relay, clears queue, resets `piStreaming`. Used by `/new` command and session switching.
- `formatForTelegram(rawText)` — centralizes MarkdownV2 escaping + `parse_mode` for one-shot messages. Returns `{ text, other? }`. In raw mode: plain text, no `parse_mode`. In MarkdownV2 mode: `escapeText()` escaped text + `{ parse_mode: "MarkdownV2" }`. Used by `showLastMessage`; apply to any future one-shot text site.
- `showStatus(chatId, data)` — formats `get_state` response into `<pre>` HTML (Model, Session, Messages, Thinking).
- `showStats(chatId, data)` — formats `get_session_stats` response into `<pre>` HTML (messages, tools, tokens with K/M abbreviation, cost).
- `showLastMessage(chatId, data)` — sends `get_last_assistant_text` response via `formatForTelegram()`. Falls back to `"(No assistant messages yet.)"` when text is null.
- `lastChatId` — stores the chat to reply to when a command's RPC response arrives.
- `currentChatId` / `currentPlaceholderMessageId` — tracks the active session's Telegram message so Pi errors can be bubbled back to the user.
- `lastPiError` — captures `errorMessage` from `message_end` or `agent_end` events when `stopReason === "error"`.
- `lastTypingSent: number` — timestamp of last `sendChatAction` for cooldown.
- `turnToolCounts: Map<toolName, count>` — accumulates tool calls via `tool_execution_start` events during an agent run. Cleared at `agent_end` (after sending summary) and `resetSession()`.
- `showTools: boolean` — toggled by `/showtools` command; when true, each `tool_execution_start` sends a live `<pre>` HTML message with truncated args.
- `deleteRequestChatId: number | string` — set by `/delete` command; triggers session deletion + reset in the `get_state` response handler. Cleared after handling.
- `deleteFile: (path: string) => Promise<void>` — injected file deletion function (defaults to `fs.promises.unlink`). Testable via mock.
- `sessionPicker: Map<sessionId, SessionInfo>` — populated by `scanRecentSessions()`; consumed by `switchToSession()`, `/delete` handler, and `resume:` callback.
- `scanRecentSessions(limit?, sessionDir?)` — calls `scanSessions()` from `sessions.ts`, populates `sessionPicker` map, returns list.
- `switchToSession(sessionId)` — looks up path in `sessionPicker`, calls `resetSession()` + sends `switch_session` RPC.

**Start block** (`if (import.meta.main)`) — creates `Bot`, instantiates `Gateway`, wires `createPiClient`, registers grammy handlers, registers bot commands with Telegram via `bot.api.setMyCommands()` (so they appear in the `/` autocomplete menu), starts long polling. Not executed when imported for tests.

### `relay.ts`

**`createRelay({ edit, debounceMs?, rawMode?, log? })` → `{ onDelta, onDone, cancel }`**

Pure function. Holds `segments`, `currentKind`, `currentText` and `editTimer` in closure.
- `onDelta(text, kind?)` — appends to current segment. On kind change (`'text'` ↔ `'thinking'`), pushes current to `segments[]` and starts a new one. Schedules debounced `edit()` call (default 600ms).
- `onDone()` — cancels timer, finalizes last segment, builds output string. Thinking segments: `> ` prefix per line. Escaping depends on `rawMode`: if false (default, MarkdownV2), thinking gets strict escape (`escapeMdV2`) and text gets relaxed escape (`escapeText`, lets `*` `_` `` ` `` through); if true (raw), no escaping applied, `> ` prefix only. Calls `edit(text, true)`. Returns `Promise<boolean>`: `true` if content was edited, `false` if buffer was empty. Clears all state.
- `cancel()` — clears timer and all segments/buffer without a final edit. Used by `resetSession()` before `/new`.

Also exports `escapeText(s: string): string` — relaxed MarkdownV2 escape that preserves `*`, `_`, `` ` ``. Used by `Gateway.formatForTelegram()` for `/last` and future one-shot messages.

### `pi-client.ts`

**`createPiClient({ path, args, env, onEvent, onLine?, onStderr?, onExit?, onError? })` → `PiClient`**

Spawns subprocess with `stdio: ['pipe','pipe','pipe']`. Reads stdout via custom `\n`-only JSONL framer (`attachJsonlReader`). Returns `{ pid, send(cmd), close() }`.
- `onLine` — called with every raw stdout line (used for `-vv` logging)
- `onEvent` — called with parsed JSON object
- `onExit` / `onError` — called on subprocess exit or spawn error

### `sessions.ts`

Session file scanning for the `/resume` command. Called by `Gateway.scanRecentSessions()` in `index.ts`.

- `SessionInfo` — `{ path, id, created, name?, mtime }` for each discovered session.
- `formatSessionDate(iso)` → `"YYYY-MM-DD HH:MM"` for button labels.
- `scanSessions(sessionDir, limit)` — walks `sessionDir` recursively for `.jsonl` files, validates session header (`type: "session"`, UUIDv7 id), reads `timestamp`, scans for latest `session_info` entry (display name). Sorts by file mtime descending, returns top N.
- Internal: `collectJsonlFiles(dir)` (recursive walk), `readSessionInfo(path)` (header + name extraction).

**Pi session file format:**
- Default dir: `~/.pi/agent/sessions/<encoded-cwd>/` (cwd with `/:\` → `-`, wrapped in `--...--`)
- Filename: `<iso-ts>_<uuidv7>.jsonl` (e.g. `2025-05-15T10-30-45-123Z_018f4a2c-....jsonl`)
- First line (header): `{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<iso>","cwd":"<path>"}`
- Name stored as: `{"type":"session_info",...,"name":"My Session"}` — appended anywhere in file, latest one wins
- `set_session_name` RPC rejects empty strings; clearing a name requires extension-level access (not yet wired)

### `tests/`

| File | Purpose |
|------|---------|
| `relay.test.ts` | Debounce, accumulation, flush, empty buffer, log callback, thinking `> ` prefix, MarkdownV2 escaping, text/thinking interleave, multiple thinking blocks |
| `gateway.test.ts` | Auth rejection, session start, queue when busy, `/` ignore, queue processing, `agent_end` → process queue, `thinking_delta` routing, fixture replay integration; command tests: `resetSession`, `showStatus`, `showStats`, `showLastMessage`, `handlePiEvent` routing for `get_state`/`get_session_stats`/`get_last_assistant_text`, fixture replay for status/context/last; **Pi error bubbling when stream produces no content**; **tool call accumulation** (single turn, multi-turn, no-tools, clear on agent_end, clear on resetSession); **typing indicator** (cooldown, reactive on work events, excluded on response/agent_end, no-op when idle); **formatToolCall** (HTML wrapping, truncation, escaping); **showTools** (sends message when on, skips when off or idle, still counts tools); **/delete** (delete session file + reset + new_session on get_state response, graceful fallback when session not in picker or no sessionId in data, does not trigger on non-get_state responses, proceeds even if unlink throws ENOENT); **session scanning tests** (`scanRecentSessions`: sort/filter/name extraction/empty dir), **session switching tests** (`switchToSession` RPC send), **/resume then /last integration test** |
| `helpers.ts` | `loadFixtureLines`, `extractTextDeltas` (mirrors relay's dual escape — strict for thinking, relaxed for text) |
| `fixtures/` | Recorded pi JSONL responses + Telegram messages from real runs. `get-state.jsonl`, `get-session-stats.jsonl`, `get-last-assistant-text.jsonl` for command integration tests |

## Data flow

```
Telegram message
  → Gateway.handleTextMessage()
    → [auth check]
    → [if busy] queue.push() + ctx.reply("Queued.")
    → [if idle] Gateway.startPiSession()
      → api.sendMessage("...")
      → createSafeEditor(api, chatId, messageId)
        → createRelay({ edit: (buf, isFinal) => editor.edit(buf, isFinal) })
      → sendPi({ type: "prompt", message: text })

Telegram command (e.g. /resume)
  → bot.command("resume", handler)
    → gateway.scanRecentSessions() → calls sessions.scanSessions(sessionDir, 8)
      → walks ~/.pi/agent/sessions/ recursively for .jsonl files
      → validates session header, extracts id/timestamp/name
      → sorts by file mtime, populates gateway.sessionPicker map
    → builds InlineKeyboard: one button per session (label: "2026-04-12 15:40 - fix-auth-bug" or "... - <last12-chars-of-uuid>")
      → callback_data: "resume:<uuid>" (fits in 64-byte limit)
    → ctx.reply("Resume a session:", { reply_markup: kb })

Telegram command (e.g. /delete)
  → bot.command("delete", handler)
    → gateway.deleteRequestChatId = ctx.chatId
    → sendPi({ type: "get_state" })
    → ctx.reply("Deleting session...")
  ... (loose coupling: response arrives later)
  → Gateway.handlePiEvent()
    → [response, command="get_state", deleteRequestChatId !== 0]
      → extract sessionId from resp.data
      → lookup in sessionPicker (rescan only if missing)
      → if found: unlink(sessionInfo.path)
      → resetSession() + sendPi({ type: "new_session" })
      → api.sendMessage(chatId, "Session deleted. New session started.")
      → clear deleteRequestChatId

Telegram callback (e.g. resume button clicked)
  → bot.callbackQuery(/^resume:(.+)$/, handler)  ← regex captures uuid
    → gateway.switchToSession(sessionId)
      → looks up path in sessionPicker
      → resetSession() (cancel relay, clear queue)
      → sendPi({ type: "switch_session", sessionPath: path })
    → ctx.answerCallbackQuery("Switched.")
    → ctx.editMessageText("Resumed session: 2026-04-12 15:40 - fix-auth-bug")

Telegram command (e.g. /name)
  → bot.command("name", handler)
    → parses ctx.match (text after /name)
    → if empty: ctx.reply("Usage: /name <name>")
    → sendPi({ type: "set_session_name", name })
    → ctx.reply("Named.")

Telegram command (e.g. /showraw)
  → bot.command("showraw", handler)
    → shows inline keyboard: Raw / MarkdownV2 with current state checked
  → bot.callbackQuery("showraw:on") → gateway.rawMode = true (next session: no escaping, plain text)
  → bot.callbackQuery("showraw:off") → gateway.rawMode = false (default: full MarkdownV2 escaping)

Telegram command (e.g. /status)
  → bot.command("status", handler)
    → [auth check]
    → gateway.lastChatId = ctx.chatId
    → sendPi({ type: "get_state" })
  ... (loose coupling: response arrives later)
  → Gateway.handlePiEvent()
    → [response, command="get_state"] → showStatus(lastChatId, data)
      → api.sendMessage(chatId, "<pre>...</pre>", { parse_mode: "HTML" })

pi stdout
  → createPiClient attachJsonlReader
    → JSON.parse(line)
    → Gateway.handlePiEvent()
      → [any event except response, agent_end] → sendTyping(chatId) (4s cooldown)
      → [response] → log success/error; route get_state/get_session_stats
      → [text_delta] → relay.onDelta(delta, 'text')
      → [thinking_delta] → relay.onDelta(delta, 'thinking')
        → [debounce 600ms] → createSafeEditor.edit(buf)
          → [OK] → api.editMessageText(lastMsg, buf, { parse_mode: "MarkdownV2" })
          → [too long] → rollback + api.sendMessage(chunks, { parse_mode: "MarkdownV2" })
          → [parse error, streaming] → skip, retry later
      → [tool_execution_start] → gateway.turnToolCounts.set(name, (count ?? 0) + 1)
        → [if showTools && currentChatId] → api.sendMessage(formatToolCall(args, name), { parse_mode: "HTML" })
      → [agent_end] → await relay.onDone() → boolean hadContent
        → [hadContent=true] → createSafeEditor.edit(final, isFinal=true)
          → [OK] → api.editMessageText(lastMsg, final, { parse_mode: "MarkdownV2" })
          → [parse error, final] → api.editMessageText(lastMsg, final) // plain text
        → [hadContent=false && lastPiError] → api.editMessageText(placeholder, `Error: ${lastPiError}`)
        → [turnToolCounts.size > 0] → api.sendMessage("🔧 N tools used: ...") + clear map
        → Gateway.processQueue()
          → [if queued] Gateway.startPiSession(next)
```

## Testing guidelines

**What to test**
- **Gateway orchestration** (`gateway.test.ts`) — auth, queueing, session lifecycle, `agent_end` → process queue.
- **Pure logic** (`relay.test.ts`) — debounce, accumulation, flush. Use fake timers, no real `setTimeout` delays.
- **Integration via fixtures** — replay recorded pi JSONL responses through `Gateway` and assert final text matches `extractTextDeltas()`.

**What NOT to test**
- grammy library (assumed perfect)
- pi binary / RPC protocol (assumed perfect)
- Actual network calls or subprocess spawning

**How to add a new fixture**
1. Run the gateway with `-vv`: `bun run index.ts -vv 2>/tmp/log`
2. Send the real Telegram message(s) you want to capture
3. Extract pi stdout lines: `grep '^pi stdout:' /tmp/log | sed 's/^pi stdout: //' > tests/fixtures/name.jsonl`
4. For text prompts: add an integration test using `loadFixtureLines('name.jsonl')` and `extractTextDeltas()`
5. For command responses (e.g. `get_state`, `get_session_stats`): replay through `handlePiEvent` with `lastChatId` set, capture `sendMessage` calls

**Test conventions**
- One concern per file (`relay.test.ts`, `gateway.test.ts`).
- Use `bun:test` — no extra test framework.
- Mock `TelegramApi` with plain objects (`sendMessage`, `editMessageText`).
- Mock `MessageContext` with plain objects (`chatId`, `from`, `msg`, `reply`).
- Helpers in `tests/helpers.ts`: `loadFixtureLines()`, `extractTextDeltas()`.

## Documentation references

- Pi RPC protocol: https://pi.dev/docs/latest/rpc
- Pi custom providers: https://pi.dev/docs/latest/custom-provider
- grammy basics: https://grammy.dev/guide/basics
- grammy context: https://grammy.dev/guide/context
- grammy Bot API: https://grammy.dev/guide/api
- grammy parse-mode plugin (reference): https://grammy.dev/plugins/parse-mode
- grammy MarkdownV2: https://core.telegram.org/bots/api#markdownv2-style
- Bun docs: https://bun.sh/docs

## Guidelines for working with the User:

- User comes from a C and bash programming background, so prefers clean, minimalist solutions and small, precise code changes.
- Simple is beautiful. Every bit of complexity that is added needs to justify its existence.
- Things that belong together should be **kept close together** in the codebase: same file when possible, or at least similar directory, filename, function name, field name, etc. - When parts have been separated for any reason, they should carry comments stating what calls/uses them, so the flow is clear for future reference.
- **Premature** abstractions are the **root of all evil**, but consolidation is preferable to writing the same code over and over.
- First we **plan** together. Afer we have a plan we agree on, User will say "*go hot*" and then you can execute **only the steps agreed on**.
- User likes to progress in small steps. **Don't rush ahead**, don't start creating anything that was not asked for, only **suggest** what you would do next.
- Don't update the tests **before** the functionality we are working on has been confirmed working by User. It's wasteful and confusing in case further changes are needed.
- Technical debt, temporary solutions, unhandled errors are OK in WIP, but **must** be marked with `XXX` comments.
- **Do not** do any `git` operations without User's explicit request.
