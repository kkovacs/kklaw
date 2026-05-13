// relay.ts — debounced streaming relay for Telegram message edits
// No external deps except setTimeout

export interface Relay {
  onDelta(text: string): void;
  onDone(): Promise<void>;
}

export function createRelay(opts: {
  edit(text: string): Promise<void>;
  debounceMs?: number;
  log?(msg: string): void;
}): Relay {
  let replyBuffer = "";
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = opts.debounceMs ?? 600;

  function scheduleEdit(): void {
    if (editTimer) return;
    opts.log?.(`scheduling edit in ${debounceMs}ms (buffer=${replyBuffer.length})`);
    editTimer = setTimeout(() => {
      editTimer = null;
      if (!replyBuffer) return;
      opts.edit(replyBuffer).catch(() => {});
    }, debounceMs);
  }

  return {
    onDelta(text: string): void {
      replyBuffer += text;
      scheduleEdit();
    },
    async onDone(): Promise<void> {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      if (!replyBuffer) {
        opts.log?.("finalize: empty buffer, nothing to edit");
        return;
      }
      opts.log?.(`final edit len=${replyBuffer.length}`);
      await opts.edit(replyBuffer).catch(() => {});
      replyBuffer = "";
    },
  };
}
