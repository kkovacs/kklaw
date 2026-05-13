// relay.ts — debounced streaming relay for Telegram message edits
// Uses @grammyjs/parse-mode for blockquote formatting on thinking content

import type { MessageEntity } from "grammy/types";
import { FormattedString } from "@grammyjs/parse-mode";

export interface Relay {
  onDelta(text: string, kind?: 'text' | 'thinking'): void;
  onDone(): Promise<void>;
}

export function createRelay(opts: {
  edit(text: string, entities?: MessageEntity[]): Promise<unknown>;
  debounceMs?: number;
  log?(msg: string): void;
}): Relay {
  type Segment = { kind: 'text' | 'thinking'; text: string };
  let segments: Segment[] = [];
  let currentKind: 'text' | 'thinking' = 'text';
  let currentText = '';
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = opts.debounceMs ?? 600;

  function buildFormattedString(): { text: string; entities?: MessageEntity[] } | null {
    const allSegs = [...segments];
    if (currentText) {
      allSegs.push({ kind: currentKind, text: currentText });
    }
    if (allSegs.length === 0) return null;

    let fs: FormattedString | null = null;
    for (const seg of allSegs) {
      if (seg.kind === 'thinking') {
        fs = fs ? fs.blockquote(seg.text) : FormattedString.blockquote(seg.text);
      } else {
        fs = fs ? fs.plain(seg.text) : new FormattedString(seg.text);
      }
    }
    return { text: fs!.text, entities: fs!.entities };
  }

  function doEdit(): void {
    const result = buildFormattedString();
    if (!result || !result.text) return;
    opts.edit(result.text, result.entities).catch(() => {});
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
      const result = buildFormattedString();
      if (!result || !result.text) {
        opts.log?.("finalize: empty buffer, nothing to edit");
        return;
      }
      opts.log?.(`final edit len=${result.text.length} segs=${segments.length}`);
      await opts.edit(result.text, result.entities).catch(() => {});
      segments = [];
      currentKind = 'text';
    },
  };
}
