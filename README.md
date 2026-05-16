# There are many personal agents, but this one is _mine_. 😀

**Chat with Pi through Telegram.** A minimalist [grammy](https://grammy.dev) bot that bridges Telegram to a [Pi](https://pi.dev) coding agent running in RPC mode — streaming responses, managing sessions, all from your phone.

## Philosophy

kklaw is small on purpose. Like Pi itself, it is tightly scoped and does not intend to grow beyond the **"One user. One DM. One Pi."** model. No multi-user, no group chats. Just you and your Pi agent harness.

**IMPORTANT!** The security model is strictly a one-person, one-channel use. No group chats. No checks and balances. Zero separaton. _Absolute power!_

It connects to Pi via RPC, not as an embedded library. You **bring your own Pi** — however you've configured it, whatever provider and model you've chosen, whatever session setup you prefer. kklaw doesn't care. It speaks the RPC protocol and stays out of your way.

It is **not a Pi extension**. Extensions run inside Pi's process and share its session lifecycle. kklaw runs independently so it can control session routing. You can connect to multiple Pi sessions from the same Telegram chat and switch between them — talk to your personal assistant in one session, work on code in another, keep them separate. That is the whole reason this exists as a standalone gateway instead of a Pi extension.

Every argument after `--` is passed through to the Pi process:

```bash
bun run index.ts -v -- -c
```

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
cp .env.example .env   # set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID
bun install

# 5/a. Run kklaw
bun run index.ts

# 5/b. Or build a standalone binary:
bun build ./index.ts --compile --minify --bytecode --outfile kklaw
./kklaw
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

Send a prompt (text, photo, or document) to talk to Pi. Prefix with `!` to run a shell command instead — e.g. `!ls -la`.

## Commands

```bash
bun install        # install dependencies
bun run index.ts   # start the gateway
bun test           # run tests
```
