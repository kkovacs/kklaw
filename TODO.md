
Larger features to develop (not at once):

kklaw:

- [x] Tool call accumulation for an agent turn, display an extra "🔧 6 tools used: bash ×5, read" message at the end of each turn
- [x] Telegram "Typing..." indicator to make sure the system is working on something
- [x] `/showtools` command that on each tool call immediately adds a message with the tool call type and truncated start of the command (not to use too much screen space, but have an idea what is happening).
- [x] A `/delete` command that deletes the current session, and implicitly starts a `/new`.
- [x] Rename the current `/status` to `/session`. Keep the `/status` command, but that one should show information about the kklaw **daemon**'s inner working: current state, uptime, etc.
- [x] /model command. Usage: `/model` => lists all available models in `<pre>`. `/model text` => shows in selection buttons models whose name contains "text". Button selection => switches model.
- [x] Any non-recognized slash command -- pass down to Pi.
- [x] Rename `/raw` to `/showraw` so all output-style toggle commands start with "show".
- [x] /quit command
- [x] Add emoji to system messages. This is the post-AI age, everything comes with emojis 🙄
- [x] Cron-driven injection of prompts into current session, like the uncommitted change we created in `telepi/`
- [ ] Ability to send bash commands with `!ls -l` - use Pi's correct RPC command.
- [ ] Pass down images from Telegram messages to Pi for models to "see".
- [ ] `/tree` and `/undo` command
- [ ] `/btw` command that executes ONE `agent_start`/`agent_end` in a (new?) Pi process with `--no-session` (temporary, forgets everything at `agent_end`)

Pi side:
- [ ] exa.ai and preplexity for search
