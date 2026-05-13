import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

export function loadFixtureLines(name: string): string[] {
  return loadFixture(name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const MDV2_ESCAPE = /([_*[\]()~`>#+\-=|{}.!\\])/g;
const MDV2_ESCAPE_TEXT = /([[\]()~>#+\-=|{}.!\\])/g;

function escapeMdV2(s: string): string {
  return s.replace(MDV2_ESCAPE, '\\$1');
}

function escapeText(s: string): string {
  return s.replace(MDV2_ESCAPE_TEXT, '\\$1');
}

export function extractTextDeltas(jsonlLines: string[]): string {
  let thinking = "";
  let text = "";
  for (const line of jsonlLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message_update") {
        const e = obj.assistantMessageEvent;
        if (e?.type === "thinking_delta" && e.delta) {
          thinking += e.delta;
        } else if (e?.type === "text_delta" && e.delta) {
          text += e.delta;
        }
      }
    } catch {
      // ignore unparsable lines
    }
  }
  // Build MarkdownV2 formatted output matching relay.ts
  let out = "";
  if (thinking) {
    const escaped = escapeMdV2(thinking);
    for (const line of escaped.split("\n")) {
      out += ">" + (line ? " " + line : "") + "\n";
    }
  }
  out += escapeText(text);
  return out;
}
