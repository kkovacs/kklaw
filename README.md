# There are many personal agents, but this one is _mine_. 😀

**Lightweight gateway to connect Pi to Telegram**

A tiny [grammy](https://grammy.dev) bot that connects your Telegram to your [Pi](https://pi.dev) agent running in RPC mode. Supports switching Pi sessions directly from your phone to keep context focused. Supports tasking your Pi agent from normal `cron` or `at`, inside the active context so you can follow up.

## Philosophy

kklaw is intentionally minimal. It is strictly **"One user. One chat. One Pi."** — no multi-user support, no group chats. Just a direct, private connection between you and your Pi agent, any way you configured that up. Full π. No checks or balances. Zero friction. Zero separaton. _Absolute power!_ 💪

You also get to run bash from Telegram like `!rm -rf /` 😅

## Inject / automation

There is no embedded cron, no scheduler — use Unix `cron`, `at`, or whatever you already have. kklaw watches an **inject directory** (`TELEGRAM_INJECT_DIR`). Any script can drop a text file into that directory, and kklaw will pick it up, delete it, and fire the contents as a prompt into the current Pi session. The response streams back to Telegram just like any other message.

This is the hook for automation. Some ideas:

- **Scheduled wake-ups** — `echo "Good morning! Here's what happened overnight..." > ~/.pi/agent/injects/wakeup.txt` from a cron job
- **Email triage** — pipe new messages from `notmuch` / `mutt` / a mail hook into an inject file
- **Monitoring alerts** — forward Prometheus alerts or health check failures so your agent can investigate
- **Webhooks** — a tiny CGI script that writes the webhook payload to the inject directory

No extra infrastructure. Just Unix and the filesystem.

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
cp .env.example .env   # Set TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID and an LLM for Pi
bun install

# 5/a. Either run kklaw with bun:
bun run index.ts

# 5/b. Or build a standalone binary:
bun build ./index.ts --compile --minify --bytecode --outfile kklaw
./kklaw
```

Every argument after `--` is passed through to the Pi process that gets started, for example, to always continue the previous session:

```bash
bun run index.ts -v -- -c
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
| `/session` | Show current session status and stats |
| `/last` | Show last assistant message |
| `/status` | Show daemon uptime, Pi pid, streaming state, queue |
| `/resume` | Browse and switch to a past session |
| `/name <name>` | Name the current session |
| `/model [filter]` | List available models, or filter + pick one |
| `/delete` | Delete the current session and start fresh |
| `/quit` | Stop the gateway |

All other slash commands are passed down to Pi.

Send a file (text, photo, or document) and it will passed to your LLM, and optionally saved. (That way you can ask your LLM to operate on it, even if it does not understand the file directly.)

Prefix with `!` to run a shell command instead — e.g. `!ls -l ~/.pi/agent/uploads/`.

## Other amazing projects similar to this one (that I tried)

Pi extensions (**can't** switch sessions):

- https://github.com/badlogic/pi-telegram - Mario's (author of Pi) original extension
- https://github.com/llblab/pi-telegram - The maintained version of the above

Gateway-style (**can** switch sessions):

- https://github.com/benedict2310/TelePi - Benedict's gateway, very similar to mine _(he came first)_, not as minimalist. Voice, screenshots, handoff!
