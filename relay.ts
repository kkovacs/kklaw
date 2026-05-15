// relay.ts — debounced streaming relay for Telegram message edits

export interface Relay {
  onDelta(text: string): void;
  onDone(): Promise<boolean>;
  cancel(): void;
}

const MDV2_ESCAPE_TEXT = /([[\]()~>#+\-=|{}.!\\])/g;

export function escapeText(s: string): string {
  return s.replace(MDV2_ESCAPE_TEXT, '\\$1');
}

export function createRelay(opts: {
  edit(text: string, isFinal?: boolean): Promise<unknown>;
  debounceMs?: number;
  log?(msg: string): void;
}): Relay {
  let buf = '';
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = opts.debounceMs ?? 600;

  function doEdit(): void {
    if (!buf) return;
    opts.edit(escapeText(buf)).catch((err) => {
      opts.log?.(`mid-stream edit failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function scheduleEdit(): void {
    if (editTimer) return;
    opts.log?.(`scheduling edit in ${debounceMs}ms (pending=${buf.length})`);
    editTimer = setTimeout(() => {
      editTimer = null;
      doEdit();
    }, debounceMs);
  }

  return {
    onDelta(text: string): void {
      buf += text;
      scheduleEdit();
    },
    async onDone(): Promise<boolean> {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      if (!buf) {
        opts.log?.("finalize: empty buffer, nothing to edit");
        return false;
      }
      const text = escapeText(buf);
      opts.log?.(`final edit len=${text.length}`);
      await opts.edit(text, true).catch(() => {});
      buf = '';
      return true;
    },
    cancel(): void {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      buf = '';
    },
  };
}
