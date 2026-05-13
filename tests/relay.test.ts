import { describe, it, expect } from "bun:test";
import { createRelay } from "../relay";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createRelay", () => {
  it("accumulates text deltas and edits after debounce", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 30,
    });

    relay.onDelta("hello");
    relay.onDelta(" world");
    expect(edits).toEqual([]); // not yet

    await sleep(60);
    expect(edits).toEqual(["hello world"]);
  });

  it("debounces multiple edits into one", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 50,
    });

    relay.onDelta("a");
    await sleep(10);
    relay.onDelta("b");
    await sleep(10);
    relay.onDelta("c");
    await sleep(10);
    expect(edits).toEqual([]);

    await sleep(60);
    expect(edits).toEqual(["abc"]);
  });

  it("onDone flushes immediately and clears buffer", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999, // never fires during test
    });

    relay.onDelta("final text");
    expect(edits).toEqual([]);

    await relay.onDone();
    expect(edits).toEqual(["final text"]);

    // After onDone, buffer is cleared; new deltas start fresh
    relay.onDelta("new");
    await relay.onDone();
    expect(edits).toEqual(["final text", "new"]);
  });

  it("onDone with empty buffer does nothing", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 30,
    });

    await relay.onDone();
    expect(edits).toEqual([]);
  });

  it("logs via optional log callback", async () => {
    const logs: string[] = [];
    const relay = createRelay({
      edit: async () => {},
      debounceMs: 30,
      log: (msg) => logs.push(msg),
    });

    relay.onDelta("x");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("scheduling edit");

    await relay.onDone();
    expect(logs.length).toBe(2);
    expect(logs[1]).toContain("final edit");
  });

  it("wraps thinking deltas with > blockquote prefix", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 30,
    });

    relay.onDelta("I think this is correct.", 'thinking');
    await relay.onDone();

    expect(edits.length).toBe(1);
    expect(edits[0]).toBe("> I think this is correct\\.\n");
  });

  it("escapes MarkdownV2 special chars in thinking content", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999,
    });

    relay.onDelta("use *bold* and _italic_", 'thinking');
    await relay.onDone();

    expect(edits[0]).toBe("> use \\*bold\\* and \\_italic\\_\n");
  });

  it("interleaves text and thinking with correct formatting", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999,
    });

    relay.onDelta("Hello. ");
    relay.onDelta("Let me think...", 'thinking');
    relay.onDelta(" Here is the answer.");
    await relay.onDone();

    // Text, then thinking blockquoted with `> ` prefix, then text (all escaped)
    expect(edits[0]).toBe("Hello\\. \n> Let me think\\.\\.\\.\n Here is the answer\\.");
  });

  it("multiple thinking blocks each get blockquote prefix", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999,
    });

    relay.onDelta("Part 1. ");
    relay.onDelta("thinking 1", 'thinking');
    relay.onDelta("Part 2. ");
    relay.onDelta("thinking 2", 'thinking');
    await relay.onDone();

    expect(edits[0]).toBe("Part 1\\. \n> thinking 1\nPart 2\\. \n> thinking 2\n");
  });

  it("lets * _ ` through in text segments so Pi's markdown renders", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999,
    });

    relay.onDelta("Use **bold** and *italic* and `code`");
    await relay.onDone();

    // `*`, `_`, `` ` `` pass through unescaped — Telegram renders them as formatting
    expect(edits[0]).toBe("Use **bold** and *italic* and `code`");
  });

  it("still escapes * _ ` inside thinking blocks", async () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: async (text) => edits.push(text),
      debounceMs: 9999,
    });

    relay.onDelta("maybe use *bold* here?", 'thinking');
    await relay.onDone();

    // Thinking uses strict escape — `*` gets escaped even though it's a formatting char
    expect(edits[0]).toBe("> maybe use \\*bold\\* here?\n");
  });
});
