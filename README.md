# There are many personal agents, but this one is _mine_. 😀

**Chat with Pi through Telegram.** kklaw connects a [grammy](https://grammy.dev) Telegram bot to a [Pi](https://pi.ai) coding agent running in RPC mode, so you can give it tasks, get streaming responses, and manage sessions — all from your phone.

**IMPORTANT!** The security model is **strictly** a one-person, one-channel use. No group chats. No checks and balances. Zero separaton. _Absolute power!_

- Send prompts and photos, get streaming replies with Markdown formatting
- Run shell commands with `!command`
- Switch models, browse/resume past sessions, toggle thinking visibility
- Inject prompts from external tools via a watched directory

## Quick start

```bash
cp .env.example .env   # set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID
# Bun loads .env from the project root (where package.json is), not from CWD
bun install
bun run index.ts
```

Optional Pi flags:

```bash
bun run index.ts -- --provider opencode-go --model minimax-m2.5 --no-session
```
