import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { createRelay, escapeText } from "../relay";

describe("createRelay", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("accumulates text deltas and edits after debounce", () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: (text) => { edits.push(text); return Promise.resolve(); },
      debounceMs: 30,
    });

    relay.onDelta("hello");
    relay.onDelta(" world");
    expect(edits).toEqual([]); // not yet

    vi.advanceTimersByTime(60);
    expect(edits).toEqual(["hello world"]);
  });

  it("debounces multiple edits into one", () => {
    const edits: string[] = [];
    const relay = createRelay({
      edit: (text) => { edits.push(text); return Promise.resolve(); },
      debounceMs: 50,
    });

    relay.onDelta("a");
    vi.advanceTimersByTime(10);
    relay.onDelta("b");
    vi.advanceTimersByTime(10);
    relay.onDelta("c");
    vi.advanceTimersByTime(10);
    expect(edits).toEqual([]);

    vi.advanceTimersByTime(30);
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
});

describe("escapeText", () => {
  it("escapes [, ], (, ), ~, >, #, +, -, =, |, {, }, ., !, \\", () => {
    expect(escapeText("[test]")).toBe("\\[test\\]");
    expect(escapeText("(parens)")).toBe("\\(parens\\)");
    expect(escapeText("~strikethrough~")).toBe("\\~strikethrough\\~");
    expect(escapeText("> quote")).toBe("\\> quote");
    expect(escapeText("# heading")).toBe("\\# heading");
    expect(escapeText("1+1=2")).toBe("1\\+1\\=2");
    expect(escapeText("foo-bar")).toBe("foo\\-bar");
    expect(escapeText("|pipe|")).toBe("\\|pipe\\|");
    expect(escapeText("{brace}")).toBe("\\{brace\\}");
    expect(escapeText(".")).toBe("\\.");
    expect(escapeText("!")).toBe("\\!");
    expect(escapeText("\\backslash")).toBe("\\\\backslash");
  });

  it("lets * _ ` through for Pi's markdown formatting", () => {
    expect(escapeText("**bold**")).toBe("**bold**");
    expect(escapeText("*italic*")).toBe("*italic*");
    expect(escapeText("_alsoitalic_")).toBe("_alsoitalic_");
    expect(escapeText("`code`")).toBe("`code`");
  });
});
