# kklaw — Telegram ↔ Pi RPC Gateway

A [bun](https://bun.com) project that bridges Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

One file: `index.ts` (~270 lines). No extra modules yet — everything is kept close for clarity.

### Pipeline

1. Telegram user sends a text message
2. grammy `message:text` handler checks `TELEGRAM_ALLOWED_USER_IDS`
3. If pi is idle → spawn placeholder `"..."` message, send `{"type":"prompt"}` to pi
4. pi streams `message_update.text_delta` events → accumulated buffer → `editMessageText` debounced at 600ms
5. On `agent_end` → final edit, clear state, process next queued message
6. If pi is busy → message goes to an in-memory queue, user gets "Queued." reply

### Key design decisions

- **Single-file**: everything in `index.ts` (JSONL framer, pi client, streaming relay, Telegram bot, queue). Extract only when needed.
- **JSONL framer is custom**: Node's `readline` is incompatible (splits on `U+2028`/`U+2029` which are valid in JSON strings). Custom `\n`-only splitter with optional `\r` strip.
- **Debounced streaming**: editing Telegram messages per-character would hit rate limits. Buffer accumulates deltas, `editMessageText` fires every 600ms, final edit on `agent_end`.
- **Sequential processing**: pi handles one prompt at a time. Incoming messages while busy are queued FIFO.
- **`--no-session`**: pi runs ephemeral (no session persistence across messages). Future: remove flag for conversation memory.
- **Pi restart on crash**: `exit` handler spawns a new pi process after 1s delay.
- **`drop_pending_updates: true`**: avoids processing stale Telegram messages on restart.

### Known gaps (marked `XXX` in code)

- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) not forwarded to user yet
- `tool_execution_*` events not displayed
- Message queue is in-memory only — lost on gateway restart
- Unauthorized users are silently ignored (no rejection reply)

## Configuration (`.env`)

Bun auto-loads `.env` — no library needed.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** (crash if missing) |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | — (empty = no one) |
| `OPENCODE_API_KEY` | passed to pi subprocess via inherited env | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |
| `PI_PROVIDER` | pi `--provider` flag | `opencode` |
| `PI_MODEL` | pi `--model` flag | (pi default) |

## Commands

```bash
bun install        # install dependencies (grammy)
bun run index.ts   # start the gateway
```

## Key code sections in `index.ts`

| Lines | Section | Purpose |
|-------|---------|---------|
| 9–26 | Config | Env vars, `~` expansion, allowlist set |
| 31–48 | JSONL Framer | `\n`-only line splitter for pi stdout |
| 53–122 | Pi RPC subprocess | spawn/restart pi, send commands, receive events |
| 127–166 | Streaming relay | debounced `editMessageText` from text_delta events |
| 171–198 | Pi event handler | routes pi events to relay, marks streaming done |
| 203–225 | Message queue | FIFO queue when pi is busy |
| 231–252 | Telegram handlers | `/start`, `message:text` with auth check |
| 257–260 | Start | spawn pi, start grammy long polling |

## Documentation references

- Pi RPC protocol: https://pi.dev/docs/latest/rpc
- Pi custom providers: https://pi.dev/docs/latest/custom-provider
- grammy basics: https://grammy.dev/guide/basics
- grammy context: https://grammy.dev/guide/context
- grammy Bot API: https://grammy.dev/guide/api
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
