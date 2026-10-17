Larger features to develop (not at once):

1. [x] Request-id RPC refactor: add `request()` to pi-client.ts and migrate every command to it; honor prompt `disposition: "handled"`/failure so `piStreaming` doesn't stick; drop `steerFallbacks`, `abortPending`, `pendingThinkLevel`, `lastChatId` routing. Update tests and docs (AGENTS.md, README).
2. [ ] `/undo` as a Pi extension using `ctx.navigateTree()` (same session file, no fork); forward `notify` extension UI events to Telegram. (Separate session, after 1.)
3. [ ] Drive multiple Pi RPC processes from one kklaw. (Separate session, after 2.)

Someday/maybe:
- [ ] `/tree` command
- [ ] A way for Pi to send files back to Telegram directly.
- [ ] `/btw` command that executes ONE `agent_start`/`agent_end` in a (new?) Pi process with `--no-session` (temporary, forgets everything at `agent_end`)
