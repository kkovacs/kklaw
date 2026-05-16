# kklaw — Telegram ↔ Pi RPC Gateway

A bun project bridging Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

Source files: `index.ts` (bot wiring + `Gateway` class), `telegram.ts` (API utils, file download, safe editor), `relay.ts` (debounced streaming + formatting), `pi-client.ts` (subprocess + JSONL), `sessions.ts` (session scanning), `inject.ts` (file-based prompt injection).

## Pipeline

1. Telegram text/photo/document → auth check (`TELEGRAM_ALLOWED_USER_ID`). Known slash commands intercepted by `bot.command()`; unknown ones pass through as prompts. `!command` triggers a `bash` RPC (not a Pi LLM prompt). Photos: largest by `file_size` picked, downloaded via Telegram `getFile`, base64-encoded as `image/jpeg`, and if `UPLOAD_DIR` is set also saved to disk with a timestamp-based name (e.g. `1747380800000.jpeg`) — a `📎 Saved: <code>&lt;full_path&gt;</code> — Sending to Pi…` reply confirms the save; otherwise `📤 Not saved (UPLOAD_DIR not set), directly sending to Pi…` is shown. Photos are auto-passed to Pi as `ImageContent[]` with the caption as prompt text. Documents: downloaded and saved to `UPLOAD_DIR` with original `file_name` preserved — the user gets a `📎 Saved: <code>&lt;full_path&gt;</code> — Pi can access it but was not notified.` reply. Documents are **never** auto-passed to the LLM; the user must send a follow-up text prompt referencing the saved file for Pi to read it. If `UPLOAD_DIR` is not set, document uploads are rejected with `"❌ UPLOAD_DIR is not set."`
2. If pi idle → send `{"type":"prompt"}` (with optional `images` for photos/documents). While working, "typing..." sent reactively on each incoming event (with cooldown, excluding `response`/`agent_end`).
3. Pi's `message_start` (assistant role) → creates a new Telegram placeholder message + per-message `Relay`. `message_update`/`text_delta` → current relay accumulates → `createSafeEditor.edit()` debounced. `thinking_delta` is dropped.
4. `message_end` → finalizes current relay. If no content produced (tool-call-only message), the placeholder is deleted. If an error arrived with no content, the placeholder is edited to show the error.
5. On `agent_end` → safety-net finalization of any remaining relay, error surfacing fallback (guarded by `piErrorSent` flag), tool summary, clear state, process next queued message.
6. If pi busy → message queued FIFO (in-memory), `👀` reaction added to the message via `ctx.react()`.

### Telegram allowed reaction emoji

`ctx.react()` uses `setMessageReaction` which only supports a fixed set of emoji (custom emoji require a premium subscription). The full list is defined in `@grammyjs/types` (`node_modules/@grammyjs/types/message.d.ts`, `ReactionTypeEmoji.emoji` union type).

| Emoji | Name |
|-------|------|
| 👍 | +1 |
| 👎 | -1 |
| ❤ | heart |
| 🔥 | fire |
| 🥰 | smiling with hearts |
| 👏 | clap |
| 😁 | grin |
| 🤔 | thinking |
| 🤯 | exploding head |
| 😱 | scream |
| 🤬 | cursing |
| 😢 | crying |
| 🎉 | party |
| 🤩 | star-struck |
| 🤮 | vomiting |
| 💩 | poop |
| 🙏 | pray |
| 👌 | ok |
| 🕊 | dove |
| 🤡 | clown |
| 🥱 | yawn |
| 🥴 | woozy |
| 😍 | heart eyes |
| 🐳 | whale |
| ❤‍🔥 | heart on fire |
| 🌚 | new moon face |
| 🌭 | hot dog |
| 💯 | 100 |
| 🤣 | rofl |
| ⚡ | lightning |
| 🍌 | banana |
| 🏆 | trophy |
| 💔 | broken heart |
| 🤨 | raised eyebrow |
| 😐 | neutral |
| 🍓 | strawberry |
| 🍾 | champagne |
| 💋 | kiss |
| 🖕 | middle finger |
| 😈 | smiling devil |
| 😴 | sleeping |
| 😭 | sobbing |
| 🤓 | nerd |
| 👻 | ghost |
| 👨‍💻 | technologist |
| 👀 | eyes |
| 🎃 | pumpkin |
| 🙈 | see-no-evil |
| 😇 | angel |
| 😨 | fearful |
| 🤝 | handshake |
| ✍ | writing |
| 🤗 | hugging |
| 🫡 | salute |
| 🎅 | santa |
| 🎄 | christmas tree |
| ☃ | snowman |
| 💅 | nail polish |
| 🤪 | zany |
| 🗿 | moai |
| 🆒 | cool |
| 💘 | heart with arrow |
| 🙉 | hear-no-evil |
| 🦄 | unicorn |
| 😘 | blowing kiss |
| 💊 | pill |
| 🙊 | speak-no-evil |
| 😎 | sunglasses |
| 👾 | alien |
| 🤷‍♂ | man shrug |
| 🤷 | shrug |
| 🤷‍♀ | woman shrug |
| 😡 | pouting |

Source: `node_modules/@grammyjs/types/message.d.ts` — `ReactionTypeEmoji.emoji` union type. This is the upstream source of truth; it mirrors [Telegram Bot API's `ReactionTypeEmoji`](https://core.telegram.org/bots/api#reactiontypeemoji). If a `REACTION_INVALID` error occurs, check this list against the current version of `@grammyjs/types`.



External tool writes a file to the inject dir → `InjectWatcher.scan()` detects, reads, deletes it → `Gateway.injectPrompt()` → same pipeline as step 2 above. Responses stream to `currentChatId` (or fall back to `allowedUserId`).

## Slash commands

Commands use loose coupling: the handler sets `lastChatId` (routing target, initialized once at startup to `allowedUserId`) and/or `currentSessionId` (for in-memory lookups, e.g. `/delete`), fires the RPC; `handlePiEvent` response handler picks it up and posts to `lastChatId`. All commands (except `/start`) require auth via `bot.filter()`.

Every `get_state` response stores `sessionId` in `Gateway.currentSessionId`. This means commands like `/delete` can use the stored ID directly without a roundtrip. `resetSession()` clears `currentSessionId`.

| Telegram command | RPC command | Response |
|------------------|-------------|----------|
| `/new` | `new_session` → (response handler) `get_state` | cancels relay + resets state; shows new session status |
| `/abort` | `abort` | cancels relay, clears streaming state, empties queue; replies "🛑 Aborted." |
| `/abort_bash` | `abort_bash` | replies "🛑 Bash aborted." |
| `/session` | `get_state` + `get_session_stats` | `showStatus()` + `showStats()` — two `<pre>` HTML messages |
| `/last` | `get_last_assistant_text` | `showLastMessage()` with MarkdownV2 escaping |
| `/status` | (none) | `showDaemonStatus()` — uptime, Pi pid, streaming state, queue |
| `/resume` | (none; filesystem scan) → button → `switch_session` → (response handler) `get_state` | scans session dir for recent `.jsonl` files, shows inline keyboard; button click fires `switch_session` RPC → `get_state` to show new session status |
| `/name <name>` | `set_session_name` | sets display name on current session; `/name` alone shows usage |
| `/model [filter]` | `get_available_models` | no filter → `<pre>` list; filter → inline keyboard buttons firing `set_model` RPC |
| `/delete` | `new_session` → (response handler) `get_state` | uses stored `currentSessionId` to unlink session file, resets, shows new session status |
| `/quit` | (none) | replies "Bye" then `process.exit(0)` |
| `!command` | `bash` | runs command via Pi bash RPC, returns output in `<pre>` chunks via response handler — routed to `lastChatId` |

## Key design decisions

- **Gateway class** accepts injectable `TelegramApi` and download/delete functions — testable with mocks.
- **JSONL framer** is custom: Node's `readline` splits on `U+2028`/`U+2029` which are valid in JSON strings. Custom `\n`-only splitter with `\r` strip.
- **Debounced streaming**: buffer accumulates deltas, `editMessageText` fires on a timer, final edit on `message_end`. New `Relay` created per assistant `message_start`; each Pi message maps to one Telegram message.
- **Reactive typing indicator**: `sendChatAction("typing")` fires on each incoming work event (with cooldown). No `setInterval`. Events like `response`/`agent_end` don't trigger it.
- **createSafeEditor** handles three error classes: `MESSAGE_TOO_LONG` (rollback + chunk-send), parse errors during streaming (skip, retry later), parse errors on final (plain text fallback).
- **MarkdownV2 escape**: relaxed escape — `*` `_` `` ` `` pass through for Pi's formatting; all other reserved chars (`[`, `(`, `~`, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`, `\`) escaped.
- **Response routing**: a single `lastChatId` field routes all command responses (status, stats, bash output, model lists, last message). `deleteInProgress` flag (boolean) — not a separate chat ID — triggers delete-specific logic on `get_state` responses alongside normal status display. 
- **Pi restart on crash**: `exit`/`error` handler spawns a new pi process after 1s delay.
- **Error bubbling**: Pi errors that produce no stream content surface to the Telegram user by editing the placeholder message. If no placeholder was created (model rejects before any assistant `message_start`), the error is sent as a new `sendMessage`. `piErrorSent` flag prevents double-surfacing across `message_end` + `agent_end`.
- **Verbosity**: `-v` = key events/states + error context, `-vv` = + `sendPi` raw + telegram msg summary (`{userId, chatId, text/caption}` — NOT full `ctx.msg`), `-vvv` = + full event JSON + raw stdout lines. Pi errors always logged to stderr regardless. Note: `-vvv` does not log the full Telegram `ctx.msg` object — it only logs selected fields (userId, chatId, text/caption).
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
- Stickers not handled

## Pi/provider gotcha

Pi stores assistant `thinking` blocks with `thinkingSignature: "reasoning"` in session history. Providers using `openai-completions` API may reject those `reasoning` fields as extra inputs, producing `400 Error from provider`. The gateway surfaces this error to the user instead of leaving a frozen placeholder. A `/new` session clears the history as a workaround.

Some providers return transient `400` errors for image prompts even when their model listing says `images: yes` (observed with Xiaomi `mimo-v2.5` via opencode-go: `400 Error from provider (Xiaomi): Param Incorrect`). The error consumes 0 tokens (request rejected before processing). Retrying the same image succeeds — identical payload, identical model. Having `UPLOAD_DIR` set allows the LLM to re-read the saved file directly without another Telegram API roundtrip.

## Pi RPC types used

```
prompt:      { type: "prompt", message: string, images?: ImageContent[] }
bash:        { type: "bash", command: string }
abort:       { type: "abort" }
abort_bash:  { type: "abort_bash" }
response:    { type: "response", command?: string, success: bool, error?: string, data?: unknown }
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
| `INJECT_DIR` | directory watched for prompt files | `~/.pi/agent/injects/` |
| `UPLOAD_DIR` | directory to save incoming photos/documents | — (disabled if unset) |

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
