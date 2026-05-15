// sessions.ts — session file scanning for /resume command
// Called by Gateway.scanRecentSessions() in index.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionInfo {
  path: string;
  id: string;
  created: string;
  name?: string;
  mtime: number;
}

export function formatSessionDate(isoTimestamp: string): string {
  return isoTimestamp.replace("T", " ").slice(0, 16);
}

function collectJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  } catch {
    // directory doesn't exist or can't be read
  }
  return results;
}

function readSessionInfo(path: string): SessionInfo | null {
  try {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    if (lines.length === 0) return null;

    // Parse header (first line)
    let header: { type: string; id: string; timestamp: string } | null = null;
    try {
      const h = JSON.parse(lines[0]);
      if (h.type === "session" && typeof h.id === "string") {
        header = h;
      }
    } catch {
      return null;
    }
    if (!header) return null;

    // Scan for session name (latest session_info entry)
    let name: string | undefined;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "session_info" && "name" in entry) {
          name = (entry.name as string)?.trim() || undefined;
        }
      } catch {
        continue;
      }
    }

    const mtime = statSync(path).mtimeMs;

    return {
      path,
      id: header.id,
      created: header.timestamp,
      name,
      mtime,
    };
  } catch {
    return null;
  }
}

export function scanSessions(sessionDir: string, limit: number): SessionInfo[] {
  const files = collectJsonlFiles(sessionDir);
  const recent: SessionInfo[] = [];
  for (const file of files) {
    const info = readSessionInfo(file);
    if (info) recent.push(info);
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  return recent.slice(0, limit);
}
