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

export function extractTextDeltas(jsonlLines: string[]): string {
  let text = "";
  for (const line of jsonlLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message_update") {
        const e = obj.assistantMessageEvent;
        if ((e?.type === "text_delta" || e?.type === "thinking_delta") && e.delta) {
          text += e.delta;
        }
      }
    } catch {
      // ignore unparsable lines
    }
  }
  return text;
}
