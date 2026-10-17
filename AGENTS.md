# kklaw — Telegram ↔ Pi RPC Gateway

A bun project bridging Telegram and the Pi coding agent using grammy and Pi's RPC mode.

## Architecture

```
Telegram user ──HTTP──→ grammy bot ──JSONL stdin──→ pi --mode rpc
                 ←──         bot ←──JSONL stdout──  pi
```

Source files: `index.ts` (bot wiring + `Gateway` class), `telegram.ts` (API utils, file download, safe editor), `relay.ts` (debounced streaming + formatting), `pi-client.ts` (subprocess + JSONL + request/response correlation), `sessions.ts` (session scanning), `inject.ts` (file-based prompt injection).

## Pipeline

1. Telegram text/photo/document/voice → auth check (`TELEGRAM_ALLOWED_USER_ID`). Known slash commands intercepted by `bot.command()`; unknown ones pass through as prompts. `!command` triggers a `bash` RPC (not a Pi LLM prompt). Photos: largest by `file_size` picked, downloaded via Telegram `getFile`, base64-encoded as `image/jpeg`, and if `UPLOAD_DIR` is set also saved to disk with a timestamp-based name (e.g. `1747380800000.jpeg`) — a `📎 Saved: <code>&lt;full_path&gt;</code> — Sending to Pi…` reply confirms the save; otherwise `📤 Not saved (UPLOAD_DIR not set), directly sending to Pi…` is shown. Photos are auto-passed to Pi as `ImageContent[]` with the caption as prompt text. Documents: downloaded and saved to `UPLOAD_DIR` with original `file_name` preserved — the user gets a `📎 Saved: <code>&lt;full_path&gt;</code> — Pi can access it but was not notified.` reply. Documents are **never** auto-passed to the LLM; the user must send a follow-up text prompt referencing the saved file for Pi to read it. If `UPLOAD_DIR` is not set, document uploads are rejected with `❌ UPLOAD_DIR is not set. Cannot save document.`. Voice messages: downloaded and saved to `UPLOAD_DIR` as `voice_<timestamp>.ogg`; Pi is then prompted with `voice message from user: <full_path>` so an audio-capable model can read the file itself. If `UPLOAD_DIR` is not set, voice uploads are rejected with `❌ UPLOAD_DIR is not set. Cannot save voice message.`.
2. If pi idle → `Gateway.startPiSession()` sends `{"type":"prompt"}` (with optional `images` for photos/documents) via `requestPi()` and awaits its preflight response. `disposition: "handled"` (an extension command such as `/undo` consumed it) or a failed response means no run started and no `agent_settled` will follow, so `piStreaming` is cleared right there (failures are shown as `❌ <error>`). While working, "typing..." sent reactively on each incoming event (with cooldown, excluding `response`/`agent_end`/`agent_settled`).
3. Pi's `message_start` (assistant role) → creates a new Telegram placeholder message + per-message `Relay`. `message_update`/`text_delta` → current relay accumulates → `createSafeEditor.edit()` debounced. `thinking_delta` is dropped.
4. `message_end` → finalizes current relay. If no content produced (tool-call-only message), the placeholder is deleted. If an error arrived with no content, the placeholder is edited to show the error.
5. On `agent_end` → safety-net finalization of any remaining relay, error surfacing fallback (guarded by `piErrorSent` flag), tool summary. `agent_end` closes only one low-level agent run — retries/recovery/steering may continue, so `piStreaming` stays true.
6. On `agent_settled` (pi will not continue automatically) → `piStreaming = false`, reset run state. This is the true idle signal.
7. If pi busy → message forwarded to the current run via the `steer` RPC (`Gateway.steerPi()`, with `images` when present), `👀` reaction added via `ctx.react()`. Unless the steer response says `disposition: "queued"`, the message is resent as a fresh `prompt`. Pi delivers it after the current turn's tool calls; the steering queue lives in the pi process (survives gateway restarts).

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

Every pi command goes through `Gateway.requestPi(cmd)`, which awaits the matching response (see "Request/response correlation" below). Each slash command is a `Gateway.cmd*()` method (`cmdNew`, `cmdDelete`, `cmdSession`, `cmdThinkingLevels`, …) that awaits its response(s) and replies to the chat it was called from; pi errors are shown as `❌ …`. The `bot.command()` wiring fires these methods with `void` and never awaits pi: grammy handles updates one at a time, so awaiting a slow command (e.g. `/compact`) would block `/abort`. All commands (except `/start`) require auth via `bot.filter()`.

Every `get_state` response (`Gateway.cmdState()`, also run at startup and after `/new`, `/delete`, `/resume`) stores `sessionId` in `Gateway.currentSessionId`. This means commands like `/delete` can use the stored ID directly without a roundtrip. `resetSession()` clears `currentSessionId`.

| Telegram command | RPC command | Response |
|------------------|-------------|----------|
| `/new` | `new_session` → `get_state` | cancels relay + resets state; shows new session status |
| `/abort` | `clear_queue` + `abort` | cancels relay, clears streaming state; replies "🛑 Aborted." once the `clear_queue` response lands, prepending `Cleared N queued messages.` when pi had steer/follow-up entries queued (plain reply on response error or 1500ms timeout) |
| `/abort_bash` | `abort_bash` | replies "🛑 Bash aborted." |
| `/session` | `get_state` + `get_session_stats` | `showStatus()` + `showStats()` — two `<pre>` HTML messages |
| `/last` | `get_last_assistant_text` | `showLastMessage()` with MarkdownV2 escaping |
| `/status` | (none) | `showDaemonStatus()` — uptime, Pi pid, streaming state |
| `/resume` | (none; filesystem scan) → button → `switch_session` → `get_state` | scans session dir for recent `.jsonl` files, shows inline keyboard; button click fires `switch_session` RPC → `get_state` to show new session status |
| `/name <name>` | `set_session_name` | sets display name on current session, replies "✏️ Named." once pi accepts; `/name` alone shows usage |
| `/model [filter]` | `get_available_models` | no filter → `<pre>` list; filter → inline keyboard buttons firing `set_model` RPC; the button message is edited to `✅ Model: …` (or the error) once pi responds |
| `/think [level]` | `get_available_thinking_levels` (list) / `set_thinking_level` (set) | no args → `<pre>` list + inline keyboard buttons firing `set_thinking_level`; with level → sets it and acks with the requested level (the set response carries no data echo) |
| `/compact [focus]` | `compact` (with optional `customInstructions`) | `showCompact()` on success (renders `tokensBefore` + heuristic `estimatedTokensAfter`); `❌ Compaction failed: …` on error |
| `/delete` | `new_session` → `get_state` | uses stored `currentSessionId` to unlink session file, resets, shows new session status |
| `/quit` | (none) | replies "Bye" then `process.exit(0)` |
| `!command` / `!!command` | `bash` | runs command via Pi bash RPC, returns output in `<pre>` chunks to the sending chat (`Gateway.runBash()`). `!!` sets `excludeFromContext: true` (output not added to context) |

## Key design decisions

- **Gateway class** accepts injectable `TelegramApi` and download/delete functions — testable with mocks.
- **JSONL framer** is custom: Node's `readline` splits on `U+2028`/`U+2029` which are valid in JSON strings. Custom `\n`-only splitter with `\r` strip.
- **Request/response correlation**: `PiClient.request(cmd)` adds a fresh `id` (`r1`, `r2`, …); pi echoes it on the response. A `type: "response"` line with a pending id resolves that request and is not passed to `onEvent` (other events may carry the same id, e.g. `bash_execution_update`, and still go to `onEvent`). Resolution runs on the same queue as event handling, so a caller resumes only after earlier events were handled — which also means `handlePiEvent` must never await `requestPi()` (deadlock). Requests never reject: pi exit/spawn error resolves every pending request with `success: false`. No default timeout; `/abort` races `clear_queue` against 1500ms itself.
- **Debounced streaming**: buffer accumulates deltas, `editMessageText` fires on a timer, final edit on `message_end`. New `Relay` created per assistant `message_start`; each Pi message maps to one Telegram message.
- **Reactive typing indicator**: `sendChatAction("typing")` fires on each incoming work event (with cooldown). No `setInterval`. Events like `response`/`agent_end`/`agent_settled` don't trigger it.
- **Idle detection**: `piStreaming` is cleared only on `agent_settled`, not `agent_end` — post-agent_end events (retries, compaction, steered turns) still route to the active chat.
- **`/think` mirrors `/model`**: same no-args list + inline-keyboard / arg-set split.
- **Mid-run forwarding via steer**: `steerPi()` awaits the steer response and resends the message as a fresh `prompt` run when the steer is rejected (e.g. sent right at `agent_end` — the agent_end→agent_settled race) or consumed with `disposition: "handled"` without starting work. `disposition: "queued"` needs no action. XXX: a message steered while a prompt is still in preflight stays queued in pi if that prompt then turns out `handled`.
  Queued steers/follow-ups live in the pi process; `/abort` drains them with `clear_queue` sent *before* `abort` (abort alone continues the run with queued messages still in the session).
- **createSafeEditor** handles three error classes: `MESSAGE_TOO_LONG` (rollback + chunk-send), parse errors during streaming (skip, retry later), parse errors on final (plain text fallback).
- **MarkdownV2 escape**: relaxed escape — `*` `_` `` ` `` pass through for Pi's formatting; all other reserved chars (`[`, `(`, `~`, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`, `\`) escaped.
- **Response routing**: each command method replies to its own `chatId` (no shared routing state). Streaming output goes to `currentChatId` (set by `startPiSession()`, cleared on `agent_settled`).
- **Pi restart on crash**: `exit`/`error` handler spawns a new pi process after a little delay.
- **Error bubbling**: Pi errors that produce no stream content surface to the Telegram user by editing the placeholder message. If no placeholder was created (model rejects before any assistant `message_start`), the error is sent as a new `sendMessage`. `piErrorSent` flag prevents double-surfacing across `message_end` + `agent_end`.
- **Verbosity**: `-v` = key events/states + error context, `-vv` = + `requestPi` raw + telegram msg summary (`{userId, chatId, text/caption}` — NOT full `ctx.msg`), `-vvv` = + full event JSON + raw stdout lines. Pi errors always logged to stderr regardless. Note: `-vvv` does not log the full Telegram `ctx.msg` object — it only logs selected fields (userId, chatId, text/caption).
- **Tool arg preview**: per-tool status message shows a short arg preview — `path` for `read`/`write`/`edit`, first line of `command` for `bash`, first non-comment line of `code` for `codemode` (skips the `//!...` options line). Unknown tools fall back to the generic `🔧 <tool>...` message. Nested tool calls (e.g. tools invoked from a codemode script, `toolCallId` = `<parentId>/<n>`, `parentToolCallId` set) each send their own message — XXX: flood risk if a script batches many calls.
- **drop_pending_updates: true** — avoids stale Telegram messages on restart.
- **Command registration via `setMyCommands`** — clears stale chat-scoped commands on startup, registers global commands so they appear in `/` autocomplete.
- **grammy handler ordering**: `bot.command()` handlers must be registered before `bot.on("message:text")` catch-all.

## Known gaps (marked `XXX` in code)

- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) not forwarded to user
- Unauthorized users are silently ignored (no rejection reply)
- `/resume` shows limited results; no pagination
- Photo media group debouncing not implemented
- Photo download has no size limit check
- Stickers not handled

## Pi/provider gotcha

Pi stores assistant `thinking` blocks with `thinkingSignature: "reasoning"` in session history. Providers using `openai-completions` API may reject those `reasoning` fields as extra inputs, producing `400 Error from provider`. The gateway surfaces this error to the user instead of leaving a frozen placeholder. A `/new` session clears the history as a workaround.

Some providers return transient `400` errors for image prompts even when their model listing says `images: yes` (observed with Xiaomi `mimo-v2.5` via opencode-go: `400 Error from provider (Xiaomi): Param Incorrect`). The error consumes 0 tokens (request rejected before processing). Retrying the same image succeeds — identical payload, identical model. Having `UPLOAD_DIR` set allows the LLM to re-read the saved file directly without another Telegram API roundtrip.

## Pi RPC types used

Every command carries an `id` (added by `PiClient.request()`); the response repeats it.

```
prompt:      { type: "prompt", message: string, images?: ImageContent[] } → data `{ disposition: "started" | "queued" | "handled" }`
steer:       { type: "steer", message: string, images?: ImageContent[] } → data `{ disposition: "queued" | "handled" }`
bash:        { type: "bash", command: string, excludeFromContext?: bool } → data `{ output, exitCode, cancelled, truncated }`
abort:       { type: "abort" }
abort_bash:  { type: "abort_bash" }
clear_queue: { type: "clear_queue" } → data `{ steering: string[], followUp: string[] }`
response:    { type: "response", id?: string, command?: string, success: bool, error?: string, data?: unknown }
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
## Guidelines for working with the User:

- User prefers clean, minimalist solutions and small, precise code changes (C/bash background).
- Simple is beautiful; added complexity must justify itself.
- Keep related code close together (same file, directory, naming patterns).
- Separated code should include comments noting its callers to preserve flow.
- Avoid premature abstraction, but prefer consolidation over duplication.
- Plan together first. Execute only after User says "go hot" on the agreed plan.
- Progress in small steps; suggest, don't execute unrequested actions.
- Don't update tests until User confirms functionality works.
- Mark WIP technical debt, hacks, and unhandled errors with `XXX` comments.
- Don't perform git operations without explicit User request.



