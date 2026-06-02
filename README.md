# There are many personal agents, but this one is _mine_. 🫡

**Lightweight gateway to connect a [Pi / π](https://pi.dev) CLI to Telegram**

A tiny self-hosted Telegram bot to talk to your Pi AI agent harness. Supports switching Pi sessions directly from your phone to keep context on leash. Supports tasking Pi from shell (normal `cron` or `at`) inside the main context so you can follow up.

## Philosophy

💅`kklaw` is _intentionally_ minimal, like Pi itself. I'm actively removing any feature that can be done easier by `bash` or by the LLM.

It is strictly **"One user. One chat. One Pi."** — there will never be multi-user support or group chats. Just a direct, private connection between you and your Pi agent, any way you configured that up. Full π. No checks or balances. Zero friction. Zero separation. _Absolute power!_ 💪

You also get to run bash commands from Telegram like `!rm -rf /` 😅

## Inject / automation

There is no embedded cron, no scheduler — use Unix `cron`, `at`, or what you already have. `kklaw` watches an **inject directory** (`INJECT_DIR`). Any script can drop a text file into that directory, and `kklaw` will pick it up, delete it, and fire the contents as a prompt into the current Pi session. The response streams back to Telegram just like any other message.

This is the hook for automation. Some use cases for the lazy and brilliant:

- **Simulate HEARTBEAT** — in the _main session_ so you can ask the LLM about it _(I'm looking at you, Hermes)_
- **Scheduled wake-ups** — Skill your LLM with `at` and `kklaw` inject, and tell it to "do this in 45 minutes"
- **Email triage** — fetch mails from cron but wake the LLM _only_ if there were any, to save money
- **Monitoring alerts** — forward alerts or health check failures so your agent can investigate
- **Log monitor** — with a `tail -f` a `grep` and a redirect, you can wake your agent when something happens
- **Webhooks** — make a tiny script that writes the webhook payload to the inject directory
- **Your own Moltbook** — Run two or more `kklaw`s that write into each other's inject directory 😈

No extra features. Just you and the filesystem.

```bash
# Example: send a daily briefing at 8 AM via cron
0 8 * * * echo "Summarize my calendar and unread emails" > ~/.pi/agent/injects/morning.txt

# OpenClaw-style HEARTBEAT
*/15 * * * * echo "Please execute HEARTBEAT.md" > ~/.pi/agent/injects/heartbeat.txt

# Example: Wake the LLM only if incoming email, only daytime
*/5 8-20 * * * fetchmail && echo "We've got email!" > ~/.pi/agent/injects/emails.txt
```

If you have Unix `at` (`apt install at` - how could they ever remove `at` from the default install? 😭 I'm sure it's `systemd`'s fault somehow.):

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
 Agent: Sir, should I execute our evil plan?
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

## Sending files

There are two ways to send files in Telegram:

1. Send _"as a photo"_ and `kklaw` will directly pass it to Pi (and also save to `UPLOAD_DIR` if set).

   ("Photo" icon in the Telegram app, _"send in a quick way"_ in Telegram web.)

2. Send any file (even images) _"as a document"_ and `kklaw` will save it to `UPLOAD_DIR` — the LLM is **not** auto-notified; send a follow-up text message referencing the saved file for Pi to read it. If `UPLOAD_DIR` is not set, documents are rejected.

   ("Document" icon in the Telegram app, _"send without compression"_ in Telegram web).

Use `!` to run a shell command — e.g. `!ls -l uploads/`. Your LLM sees the output on the next turn. Use `!!` with the same syntax to run a command without later injecting its output into the LLM context.

Currently there is no way for Pi to send files back to Telegram. If you need that, use `git` sync (see below), tell the LLM to send files to you via email, or to run `timeout 30 -- python -m http.server` with Tailscale, or anything. :)

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

You can use `cron` and `tmux` (or anything else).

This example runs in a loop with a 5 sec backoff, so to restart `kklaw` just send it `/quit`. If you want a fresh session on every restart, remove `--continue`. If you just hate sessions, add `--no-session`. If you want extensions, keep adding `-e`s. These are all just `pi`'s options.

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
| `/abort_bash` | Abort a running `!` / `!!` bash command |
| `/compact [focus]` | Compact conversation context (optional focus instructions) |
| `/quit` | Stop the gateway |
| `!command` | Run a shell command via Pi; output goes into LLM context |
| `!!command` | Run a shell command via Pi; output stays out of LLM context |

All other slash commands are passed down to Pi. (To use skills, etc.) All errors are passed up to you on Telegram.

## Software that pairs nicely with 💅`kklaw`

I use [🌳VMTREE](https://github.com/kkovacs/vmtree) for a self-hosted, minimalist, isolated running environment.

I run Pi in a "workspace" directory that is a `git` repo it can push/pull, and I have [working copy](https://workingcopyapp.com/) on my devices to see the same files. (I tried [Obsidian](https://obsidian.md/) too, but `git` sync was convoluted and error-prone.)

Tips for the VM:

```bash
# From Ubuntu
sudo apt install -y curl wget git socat rsync jq gron unzip ripgrep fdm swaks pandoc at imagemagick ffmpeg docker.io docker-compose-v2

# Linux-brew - https://brew.sh/
brew install duckdb go uv node gogcli
brew install oven-sh/bun/bun

# Chrome for a SKILL to browse with https://bun.com/docs/runtime/webview
curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo dpkg -i google-chrome-stable_current_amd64.deb ; sudo apt install -f -y

# Use your own SYSTEM prompt with Pi
cat > .pi/SYSTEM.md <<EOF
You are Alfred, a helpful personal assistant to Batman.
You have uv and bun. You can use Chrome via <https://bun.com/docs/runtime/webview>
You git pull/push the workspace when making changes.
EOF
```

## Other amazing projects similar to this one _(that I tried)_

Pi extensions (**can't** switch sessions):

- https://github.com/badlogic/pi-telegram - Mario's (author of Pi) original extension
- https://github.com/llblab/pi-telegram - Well-maintained version of the above

Gateway-style (**can** switch sessions):

- https://github.com/benedict2310/TelePi - Benedict's gateway, similar to mine _(he came first)_, better name, more features: Voice, screenshots, handoff! Try it!

Daddy:

- https://pi.dev/ - Great thanks to Mario Zechner and the Vienna gang for Pi, OpenClaw, etc: none of this would be possible without them, and I would actually be sleeping at night instead of working on this.
