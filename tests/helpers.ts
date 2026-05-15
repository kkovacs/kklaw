import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

export function loadFixtureLines(name: string): string[] {
  const content = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
