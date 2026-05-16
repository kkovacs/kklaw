# There are many personal agents, but this one is _mine_. 🫡

**Lightweight gateway to connect Pi to Telegram**

A tiny self-hosted Telegram bot to connect to your [Pi](https://pi.dev) agent. Supports switching Pi sessions directly from your phone to keep context focused. Supports tasking Pi from shell (normal `cron` or `at`) inside the active context so you can follow up.

## Philosophy

kklaw is _intentionally_ minimal, like Pi itself. I'm actively removing any feature that can be done easier by `bash` or by the LLM.

It is strictly **"One user. One chat. One Pi."** — there will never be multi-user support or group chats. Just a direct, private connection between you and your Pi agent, any way you configured that up. Full π. No checks or balances. Zero friction. Zero separaton. _Absolute power!_ 💪

You also get to run bash commands from Telegram like `!rm -rf /` 😅

## Inject / automation

There is no embedded cron, no scheduler — use Unix `cron`, `at`, or whatever you already have. kklaw watches an **inject directory** (`TELEGRAM_INJECT_DIR`). Any script can drop a text file into that directory, and kklaw will pick it up, delete it, and fire the contents as a prompt into the current Pi session. The response streams back to Telegram just like any other message.

This is the hook for automation. Some ideas:

- **Scheduled wake-ups** — `echo "Good morning! Here's what happened overnight..." > ~/.pi/agent/injects/wakeup.txt` from a cron job
- **Email triage** — pipe new messages from `notmuch` / `mutt` / a mail hook into an inject file
- **Monitoring alerts** — forward Prometheus alerts or health check failures so your agent can investigate
- **Webhooks** — a tiny CGI script that writes the webhook payload to the inject directory

No extra features. Just Unix and the filesystem.

```bash
# Example: send a daily briefing at 8 AM via cron
0 8 * * * echo "Summarize my calendar and unread emails" > ~/.pi/agent/injects/morning.txt
```

## How It Works

kklaw starts the `pi` binary rather than running it as an embedded library. This lets you bring your own Pi instance — any extensions, skills, configuration — and kklaw acts as a lightweight bridge to Telegram.

It uses RPC specifically to enable **session switching**. Unlike Pi extensions (which run inside Pi and are locked to one session), kklaw lets you route between multiple Pi sessions from the same Telegram chat. This allows you to maintain focused contexts or keep different tasks (e.g., personal assistant vs. project work) cleanly separated.

## Quick start

```bash
# 1. Install Pi (see https://pi.dev)
curl -fsSL https://pi.dev/install.sh | sh

# 2. Install bun (see https://bun.com)
curl -fsSL https://bun.com/install | bash

# 3. Clone kklaw
git clone https://github.com/kkovacs/kklaw
cd kklaw

# 4. Install deps and configure
cp .env.example .env   # Set TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID and an LLM
bun install

# 5/a. Either run kklaw with bun:
bun run index.ts

# 5/b. Or build a standalone binary:
bun build ./index.ts --compile --minify --bytecode --outfile kklaw
./kklaw
```

Every argument after the `--` is passed through to the Pi process that gets started. For example, to start kklaw in extra-verbose mode, and always continue the previous session:

```bash
bun run index.ts -vvv -- --continue
```

## Configuration (`.env`)

Bun auto-loads `.env` from the project root (where `package.json` is), not from CWD.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | — |
| `OPENCODE_API_KEY` | passed to pi subprocess via inherited env | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |
| `PI_SESSION_DIR` | root dir for session `.jsonl` scan | `~/.pi/agent/sessions/` |
| `TELEGRAM_INJECT_DIR` | directory watched for prompt files | `~/.pi/agent/injects/` |
| `MEDIA_UPLOAD_PATH` | directory to save incoming photos/documents | — (disabled if unset) |

## Slash commands

| Command | What it does |
|---------|--------------|
| `/new` | Start a fresh session |
| `/resume` | Browse and switch to a past session |
| `/last` | Show last assistant message (useful after `/resume`) |
| `/name <name>` | Name the current session |
| `/delete` | Delete the current session and start fresh |
| `/model [filter]` | List all available LLMs, or filter + pick one |
| `/status` | Show kklaw uptime, Pi pid, streaming state, queue |
| `/session` | Show Pi session status and stats |
| `/quit` | Stop the gateway |

All other slash commands are passed down to Pi. All errors are passed up to you on Telegram.

Send any photo or file and it will be passed down to the LLM, and also saved (if `MEDIA_UPLOAD_PATH` is set. That way you can ask your LLM to operate on the file, even if it does not understand the file directly.)

Prefix with `!` to run a shell command — e.g. `!ls -l ~/.pi/agent/uploads/`. Your LLM sees the output on the next turn.

## Other amazing projects similar to this one (that I tried)

Pi extensions (**can't** switch sessions):

- https://github.com/badlogic/pi-telegram - Mario's (author of Pi) original extension
- https://github.com/llblab/pi-telegram - Maintained version of the above

Gateway-style (**can** switch sessions):

- https://github.com/benedict2310/TelePi - Benedict's gateway, very similar to mine _(he came first)_, not as minimalist. Voice, screenshots, handoff! Try it!
