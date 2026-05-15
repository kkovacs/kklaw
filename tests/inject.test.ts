import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InjectWatcher } from "../inject";

describe("InjectWatcher", () => {
  it("processes two files and deletes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inject-test-"));
    try {
      writeFileSync(join(dir, "hello.txt"), "hello world");
      writeFileSync(join(dir, "bye.txt"), "goodbye");

      const calls: { text: string; filename: string }[] = [];
      const watcher = new InjectWatcher(dir, (text, filename) => calls.push({ text, filename }), 100);

      await watcher.start();
      watcher.stop();

      expect(calls.length).toBe(2);
      expect(calls.find(c => c.filename === "hello.txt")?.text).toBe("hello world");
      expect(calls.find(c => c.filename === "bye.txt")?.text).toBe("goodbye");

      const remaining = readdirSync(dir);
      expect(remaining).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips empty files but still deletes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inject-test-"));
    try {
      writeFileSync(join(dir, "empty.txt"), "");
      writeFileSync(join(dir, "real.txt"), "something");

      const calls: { text: string; filename: string }[] = [];
      const watcher = new InjectWatcher(dir, (text, filename) => calls.push({ text, filename }), 100);

      await watcher.start();
      watcher.stop();

      expect(calls.length).toBe(1);
      expect(calls[0].filename).toBe("real.txt");
      expect(calls[0].text).toBe("something");

      const remaining = readdirSync(dir);
      expect(remaining).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates directory if missing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "inject-test-")), "nested", "missing");
    try {
      const watcher = new InjectWatcher(dir, () => {}, 100);
      await watcher.start();
      watcher.stop();

      const entries = readdirSync(dir);
      expect(entries).toEqual([]);
    } finally {
      // Clean from the temp root up
      const root = dir.split("/").slice(0, -2).join("/") || dir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives unreadable file (no crash)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inject-test-"));
    try {
      writeFileSync(join(dir, "good.txt"), "ok");
      // Create a directory entry so readFile fails (isDirectory)
      const calls: { text: string; filename: string }[] = [];
      const watcher = new InjectWatcher(dir, (text, filename) => calls.push({ text, filename }), 100);

      await watcher.start();
      watcher.stop();

      expect(calls.length).toBe(1);
      expect(calls[0].filename).toBe("good.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
