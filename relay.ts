// relay.ts — debounced streaming relay for Telegram message edits
// Builds MarkdownV2 text: text segments pass through as-is, thinking segments
// are escaped and wrapped in `> ` blockquote prefix.

export interface Relay {
  onDelta(text: string, kind?: 'text' | 'thinking'): void;
  onDone(): Promise<void>;
  cancel(): void;
}

const MDV2_ESCAPE = /([_*[\]()~`>#+\-=|{}.!\\])/g;
// Relaxed: allows `*`, `_`, `` ` `` through so Pi's **bold** / *italic* / `code` render
const MDV2_ESCAPE_TEXT = /([[\]()~>#+\-=|{}.!\\])/g;

function escapeMdV2(s: string): string {
  return s.replace(MDV2_ESCAPE, '\\$1');
}

function escapeText(s: string): string {
  return s.replace(MDV2_ESCAPE_TEXT, '\\$1');
}

export function createRelay(opts: {
  edit(text: string, isFinal?: boolean): Promise<unknown>;
  debounceMs?: number;
  log?(msg: string): void;
}): Relay {
  type Segment = { kind: 'text' | 'thinking'; text: string };
  let segments: Segment[] = [];
  let currentKind: 'text' | 'thinking' = 'text';
  let currentText = '';
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = opts.debounceMs ?? 600;

  function buildText(): string {
    const allSegs = [...segments];
    if (currentText) {
      allSegs.push({ kind: currentKind, text: currentText });
    }

    let out = '';
    for (const seg of allSegs) {
      if (seg.kind === 'thinking') {
        // Ensure blockquote `> ` lands at line start
        if (out && !out.endsWith('\n')) out += '\n';
        const escaped = escapeMdV2(seg.text);
        const lines = escaped.split('\n');
        for (const line of lines) {
          out += '>' + (line ? ' ' + line : '') + '\n';
        }
      } else {
        out += escapeText(seg.text);
      }
    }
    return out;
  }

  function doEdit(): void {
    const text = buildText();
    if (!text) return;
    opts.edit(text).catch(() => {});
  }

  function scheduleEdit(): void {
    if (editTimer) return;
    opts.log?.(`scheduling edit in ${debounceMs}ms (segs=${segments.length}, pending=${currentText.length})`);
    editTimer = setTimeout(() => {
      editTimer = null;
      doEdit();
    }, debounceMs);
  }

  return {
    onDelta(text: string, kind: 'text' | 'thinking' = 'text'): void {
      if (kind !== currentKind && currentText) {
        segments.push({ kind: currentKind, text: currentText });
        currentText = '';
      }
      currentKind = kind;
      currentText += text;
      scheduleEdit();
    },
    async onDone(): Promise<void> {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      if (currentText) {
        segments.push({ kind: currentKind, text: currentText });
        currentText = '';
      }
      const text = buildText();
      if (!text) {
        opts.log?.("finalize: empty buffer, nothing to edit");
        return;
      }
      opts.log?.(`final edit len=${text.length} segs=${segments.length}`);
      await opts.edit(text, true).catch(() => {});
      segments = [];
      currentKind = 'text';
    },

    cancel(): void {
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      segments = [];
      currentKind = 'text';
      currentText = '';
    },
  };
}
