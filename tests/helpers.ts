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
      if (
        obj.type === "message_update" &&
        obj.assistantMessageEvent?.type === "text_delta"
      ) {
        text += obj.assistantMessageEvent.delta;
      }
    } catch {
      // ignore unparsable lines
    }
  }
  return text;
}
