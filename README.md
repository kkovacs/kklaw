# There are many personal agents, but this one is _mine_. 🫡

**Lightweight gateway to connect Pi to Telegram**

A tiny self-hosted Telegram bot to talk to your [Pi](https://pi.dev) AI agent harness. Supports switching Pi sessions directly from your phone to keep context on leash. Supports tasking Pi from shell (normal `cron` or `at`) inside the main context so you can follow up.

## Philosophy

💅`kklaw` is _intentionally_ minimal, like Pi itself. I'm actively removing any feature that can be done easier by `bash` or by the LLM.

It is strictly **"One user. One chat. One Pi."** — there will never be multi-user support or group chats. Just a direct, private connection between you and your Pi agent, any way you configured that up. Full π. No checks or balances. Zero friction. Zero separaton. _Absolute power!_ 💪

You also get to run bash commands from Telegram like `!rm -rf /` 😅

## Inject / automation

There is no embedded cron, no scheduler — use Unix `cron`, `at`, or whatever you already have. `kklaw` watches an **inject directory** (`INJECT_DIR`). Any script can drop a text file into that directory, and `kklaw` will pick it up, delete it, and fire the contents as a prompt into the current Pi session. The response streams back to Telegram just like any other message.

This is the hook for automation. Some ideas:

- **Simulate HEARTBEAT** — in the _main session_ so you can ask the LLM about it _(I'm looking at you, Hermes)_
- **Scheduled wake-ups** — Skill your LLM with `at` and `kklaw` inject, and tell it to "do this in 45 minutes"
- **Email triage** — fetch mails from cron but wake the LLM _only_ if there was any
- **Monitoring alerts** — forward alerts or health check failures so your agent can investigate
- **Log monitor** — with a `tail -f` a `grep` and a redirect, you can wake your agent when something happens
- **Webhooks** — make a tiny script that writes the webhook payload to the inject directory
- **Your own Moltbook** — Run two or more `kklaw`s that write into each other's inject directory 😈

No extra features. Just you and the filesystem.

```bash
# Example: send a daily briefing at 8 AM via cron
0 8 * * * echo "Summarize my calendar and unread emails" > ~/.pi/agent/injects/morning.txt

# OpenClaw-style HEARTBEAT
*/15 * * * * echo "Please do HEARTBEAT.md" > ~/.pi/agent/injects/heartbeat.txt

# Example: Wake the LLM only if incoming email, only in daytime
*/5 8-20 * * * fetchmail && echo "Read the emails!" > ~/.pi/agent/injects/emails.txt
```

If you have `apt install at` (how could they ever remove `at` from the default install? I'm sure it's `systemd`'s fault somehow):

```bash
at now + 10 minutes <<EOF
echo "Initiate self-destruct sequence!" > /home/user/.pi/agent/injects/hi.txt
EOF

at 08:30 tomorrow << END
cat > /home/user/.pi/agent/injects/morning-brief.md << 'MSG'
Reminder for tomorrow morning:

- Review PR #42
- Prep for 10am client call
- Push timesheet
- Start doomsday machine
MSG
END
```

## Session switching

Unlike Pi extensions (which run inside Pi and are locked to one session), `kklaw` lets you route between multiple Pi sessions from the same Telegram chat. This allows you to maintain focused contexts or keep different tasks (e.g., personal assistant vs. project work) cleanly separated.

For example, juggling multiple sessions:

```
── Session "evil plan" ──
 Agent: So, should I execute our evil plan?
  User: /new                       ← start a fresh session, shelving this one
── Session "new" (unnamed) ──
  User: By the way, what's 300 feet to km?
 Agent: 300 feet = 0.09144 km (or about 91.4 meters).
  User: And in NM?
 Agent: 300 feet = 0.0494 NM (nautical miles).
  User: /delete                    ← nuke this session, it was just a calculator
  User: /resume                    ← pick "evil plan" from the inline menu
── Session "evil plan" (resumed) ──
  User: Yes, proceed with the evil plan.
 Agent: Aye aye, sir! 🫡
  User: /resume                    ← pick "groceries" from the inline menu
── Session "groceries" (resumed) ──
  User: Also, add 2 kgs of garlic to the list.
 Agent: As you wish, my love. 💕
```

## INSTALL

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

Every argument after the `--` is passed through to the Pi process that gets started. For example, to start `kklaw` in extra-verbose mode, and always continue the previous session:

```bash
bun run index.ts -vvv -- --continue
```

## Start on boot

You can also use `cron` and `tmux`. (Or you can use anything else.) This example runs in a loop with a 5 sec backoff, so to restart `kklaw` just send it `/quit`. If you want a fresh session on every restart, remove `--continue`. If you just hate sessions, add `--no-session`. If you want extensions, keep adding `-e`s. These are all just `pi`'s options.

```
@reboot tmux new-session -d -s kklaw 'cd ~/workspace/; while true; do ( set -a ; . .env ; set +a ; bun run ~/kklaw/index.ts -v -- --continue ; sleep 5 ); done'
```

## Configuration (`.env`)

Bun auto-loads `.env` from the project root (where `package.json` is), not from CWD.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | grammy bot token | **required** |
| `TELEGRAM_ALLOWED_USER_ID` | single Telegram user ID to accept | **required** |
| `..._API_KEY` | any [provider key](https://pi.dev/docs/latest/providers) works | — |
| `PI_PATH` | path to pi binary (`~` expanded) | `pi` (in PATH) |
| `INJECT_DIR` | directory watched for prompt files | `~/.pi/agent/injects/` |
| `UPLOAD_DIR` | directory to save incoming photos/documents | — (disabled if unset) |
| `PI_SESSION_DIR` | root dir for session `.jsonl` scan | `~/.pi/agent/sessions/` |

## Slash commands

| Command | What it does |
|---------|--------------|
| `/new` | Start a fresh session |
| `/resume` | Browse and switch to a past session |
| `/last` | Show last assistant message (useful after `/resume`) |
| `/name <name>` | Name the current session |
| `/delete` | Delete the current session and start fresh |
| `/model [filter]` | List all available LLMs, or filter + pick one |
| `/status` | Show `kklaw` uptime, Pi pid, streaming state, queue |
| `/session` | Show Pi session status and stats |
| `/abort` | Abort the current agent turn (including tools) |
| `/abort_bash` | Abort a running `!` bash command |
| `/quit` | Stop the gateway |

All other slash commands are passed down to Pi. All errors are passed up to you on Telegram.

Send any photo or file and it will be passed down to the LLM, and also saved (if `UPLOAD_DIR` is set. That way you can ask your LLM to operate on the file, even if it does not understand the file directly.)

Prefix with `!` to run a shell command — e.g. `!ls -l ~/.pi/agent/uploads/`. Your LLM sees the output on the next turn.

## Other amazing projects similar to this one (that I tried)

Pi extensions (**can't** switch sessions):

- https://github.com/badlogic/pi-telegram - Mario's (author of Pi) original extension
- https://github.com/llblab/pi-telegram - Maintained version of the above

Gateway-style (**can** switch sessions):

- https://github.com/benedict2310/TelePi - Benedict's gateway, similar to mine _(he came first)_, better name, more features: Voice, screenshots, handoff! Try it!
