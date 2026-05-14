# kklaw — Telegram ↔ Pi RPC Gateway

A [bun](https://bun.com) project that bridges Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

Three files: `index.ts` (~200 lines, bot wiring + `Gateway` class), `relay.ts` (~80 lines, debounced streaming + formatting), `pi-client.ts` (~70 lines, subprocess + JSONL). Extracted for testability.

### Pipeline

1. Telegram user sends a text message or slash command
2. grammy `message:text` handler checks `TELEGRAM_ALLOWED_USER_ID`
3. If pi is idle → spawn placeholder `"..."` message, send `{"type":"prompt"}` to pi
4. pi streams `message_update` events (`text_delta` + `thinking_delta`) → relay accumulates segments, thinking wrapped in `> ` blockquote (MarkdownV2) → `editMessageText` with `parse_mode: "MarkdownV2"` debounced at 600ms
5. On `agent_end` → final edit, clear state, process next queued message
6. If pi is busy → message goes to an in-memory queue, user gets "Queued." reply

#### Slash commands (Telegram → Pi RPC)

Commands use a **loose coupling** pattern: the command handler stores `lastChatId`, fires the RPC command; the `handlePiEvent` response handler picks it up and posts to that chat. Single user, single connection, no promise plumbing.

| Telegram command | RPC command | Response handler |
|------------------|-------------|------------------|
| `/new` | `new_session` | logs response; also cancels relay + resets state via `resetSession()` |
| `/status` | `get_state` | `showStatus()` → formats into `<pre>` HTML block |
| `/context` | `get_session_stats` | `showStats()` → formats token counts (K/M) + cost into `<pre>` HTML block |

### Key design decisions

- **Separated for testability**: `relay.ts` (pure debounce logic), `pi-client.ts` (I/O boundary), `index.ts` (`Gateway` class + wiring). Extracted only when testing became the goal.
- **Testable core**: `Gateway` class accepts `TelegramApi` and `PiClient` as injectable deps. Tests use mock APIs, no real Telegram or pi needed.
- **JSONL framer is custom**: Node's `readline` is incompatible (splits on `U+2028`/`U+2029` which are valid in JSON strings). Custom `\n`-only splitter with optional `\r` strip.
- **Debounced streaming**: editing Telegram messages per-character would hit rate limits. Buffer accumulates deltas, `editMessageText` fires every 600ms, final edit on `agent_end`.
- **Thinking via blockquote**: `thinking_delta` events are streamed alongside `text_delta`. The relay interleaves segments, wrapping thinking content in `> ` prefix (MarkdownV2 blockquote) with special characters escaped.
- **MarkdownV2 with dual escape**: the entire message is sent with `parse_mode: "MarkdownV2"`. Two escape levels:
  - **Thinking**: strict escape (all reserved chars) → no accidental formatting inside `> ` blockquotes
  - **Text**: relaxed escape (`*`, `_`, `` ` `` pass through) → Pi's `**bold**`, `*italic*`, `` `code` `` render
  - Other reserved chars (`!`, `.`, `[`, `]`, `~`, etc.) are always escaped to prevent parse errors (400 Bad Request)
- **Sequential processing**: pi handles one prompt at a time. Incoming messages while busy are queued FIFO.
- **Pi restart on crash**: `exit` handler spawns a new pi process after 1s delay.
- **`drop_pending_updates: true`**: avoids processing stale Telegram messages on restart.

### Known gaps (marked `XXX` in code)

- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) not forwarded to user yet
- `tool_execution_*` events not displayed
- Message queue is in-memory only — lost on gateway restart
- Unauthorized users are silently ignored (no rejection reply)
- Other builtin slash commands (`/model`, `/compact`, `/fork`, etc.) not registered yet

## Configuration (`.env`)

Bun auto-loads `.env` — no library needed.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** (crash if missing) |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | — (empty = no one) |
| `OPENCODE_API_KEY` | passed to pi subprocess via inherited env | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |

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
- `startPiSession(chatId, text, api?)` — sets `piStreaming = true`, sends "..." placeholder, creates a `Relay`, sends `{"type":"prompt",...}` to pi.
- `handlePiEvent(event)` — routes pi events:
  - `response` — log success/error; routes `get_state` → `showStatus()` and `get_session_stats` → `showStats()` when `lastChatId` is set
  - `message_update` with `text_delta` → `relay.onDelta(delta, 'text')`
  - `message_update` with `thinking_delta` → `relay.onDelta(delta, 'thinking')`
  - `agent_end` → `relay.onDone()`, then `processQueue()`
- `processQueue(api?)` — if pi idle, dequeues next message and calls `startPiSession`.
- `sendPi(cmd)` — JSON-stringifies and sends to `piClient`.
- `resetSession()` — cancels relay, clears queue, resets `piStreaming`. Used by `/new` command.
- `showStatus(chatId, data)` — formats `get_state` response into `<pre>` HTML (Model, Session, Messages, Thinking).
- `showStats(chatId, data)` — formats `get_session_stats` response into `<pre>` HTML (messages, tools, tokens with K/M abbreviation, cost).
- `lastChatId` — stores the chat to reply to when a command's RPC response arrives.

**Start block** (`if (import.meta.main)`) — creates `Bot`, instantiates `Gateway`, wires `createPiClient`, registers grammy handlers, starts long polling. Not executed when imported for tests.

### `relay.ts`

**`createRelay({ edit, debounceMs?, log? })` → `{ onDelta, onDone, cancel }`**

Pure function. Holds `segments`, `currentKind`, `currentText` and `editTimer` in closure.
- `onDelta(text, kind?)` — appends to current segment. On kind change (`'text'` ↔ `'thinking'`), pushes current to `segments[]` and starts a new one. Schedules debounced `edit()` call (default 600ms).
- `onDone()` — cancels timer, finalizes last segment, builds MarkdownV2 string: thinking segments → strict escape (`escapeMdV2`) + `> ` prefix per line; text segments → relaxed escape (`escapeText`, lets `*` `_` `` ` `` through). Clears all state.
- `cancel()` — clears timer and all segments/buffer without a final edit. Used by `resetSession()` before `/new`.

### `pi-client.ts`

**`createPiClient({ path, args, env, onEvent, onLine?, onStderr?, onExit?, onError? })` → `PiClient`**

Spawns subprocess with `stdio: ['pipe','pipe','pipe']`. Reads stdout via custom `\n`-only JSONL framer (`attachJsonlReader`). Returns `{ pid, send(cmd), close() }`.
- `onLine` — called with every raw stdout line (used for `-vv` logging)
- `onEvent` — called with parsed JSON object
- `onExit` / `onError` — called on subprocess exit or spawn error

### `tests/`

| File | Purpose |
|------|---------|
| `relay.test.ts` | Debounce, accumulation, flush, empty buffer, log callback, thinking `> ` prefix, MarkdownV2 escaping, text/thinking interleave, multiple thinking blocks |
| `gateway.test.ts` | Auth rejection, session start, queue when busy, `/` ignore, queue processing, `agent_end` → process queue, `thinking_delta` routing, fixture replay integration; command tests: `resetSession`, `showStatus`, `showStats`, `handlePiEvent` routing for `get_state`/`get_session_stats`, fixture replay for status/context |
| `helpers.ts` | `loadFixtureLines`, `extractTextDeltas` (mirrors relay's dual escape — strict for thinking, relaxed for text) |
| `fixtures/` | Recorded pi JSONL responses + Telegram messages from real runs. `get-state.jsonl`, `get-session-stats.jsonl` for command integration tests |

## Data flow

```
Telegram message
  → Gateway.handleTextMessage()
    → [auth check]
    → [if busy] queue.push() + ctx.reply("Queued.")
    → [if idle] Gateway.startPiSession()
      → api.sendMessage("...")
      → createRelay({ edit: api.editMessageText })
      → sendPi({ type: "prompt", message: text })

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
      → [response] → log success/error; route get_state/get_session_stats
      → [text_delta] → relay.onDelta(delta, 'text')
      → [thinking_delta] → relay.onDelta(delta, 'thinking')
        → [debounce 600ms] → api.editMessageText(buf, { parse_mode: "MarkdownV2" })
      → [agent_end] → relay.onDone()
        → api.editMessageText(final, { parse_mode: "MarkdownV2" })
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
- In coding, things that belong together should be **kept close together**: same file when possible, or similar directory, filename, function name, field name, etc. When parts have been separated for any reason, they should carry comments stating what calls/uses them, so the flow is clear for future reference.
- First we **plan** together. Afer we have a plan we agree on, User will say "*go hot*" and then you can execute only the **steps agreed on**.
- User likes to progress in small steps. **Don't rush ahead**, don't create/develop anything that was not asked, only **suggest** what you would do next.
- **Premature** abstractions are the **root of all evil**, but consolidation is preferable to writing the same code over and over.
- Technical debt, temporary solutions, unhandled errors are OK in WIP, but **must** be marked with `XXX` comments.
- **Do not** do any `git` operations without User's explicit request.
