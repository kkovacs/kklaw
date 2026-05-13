import { describe, it, expect } from "bun:test";
import type { MessageEntity } from "grammy/types";
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

  it("wraps thinking deltas in blockquote entities", async () => {
    const edits: { text: string; entities?: MessageEntity[] }[] = [];
    const relay = createRelay({
      edit: async (text, entities) => edits.push({ text, entities }),
      debounceMs: 30,
    });

    relay.onDelta("I think this is correct.", 'thinking');
    await relay.onDone();

    expect(edits.length).toBe(1);
    const first = edits[0]!;
    expect(first.entities?.length).toBe(1);
    expect(first.entities?.[0]!.type).toBe("blockquote");
    // Blockquote entity spans the entire thinking text
    expect(first.entities?.[0]!.offset).toBe(0);
    expect(first.entities?.[0]!.length).toBe(first.text.length);
  });

  it("interleaves text and thinking with correct formatting", async () => {
    const edits: { text: string; entities?: MessageEntity[] }[] = [];
    const relay = createRelay({
      edit: async (text, entities) => edits.push({ text, entities }),
      debounceMs: 9999,
    });

    relay.onDelta("Hello. ");
    relay.onDelta("Let me think...", 'thinking');
    relay.onDelta(" Here is the answer.");
    await relay.onDone();

    expect(edits.length).toBe(1);
    // Should have one blockquote entity for the thinking part
    const entities = edits[0]!.entities!;
    const bqEntities = entities.filter((e) => e.type === "blockquote");
    expect(bqEntities.length).toBe(1);
    // The blockquote should cover text starting at offset 7 ("Hello. " is 7 chars)
    expect(bqEntities[0]!.offset).toBe(7);
    expect(bqEntities[0]!.length).toBe("Let me think...".length);
  });

  it("multiple thinking blocks each get blockquote entities", async () => {
    const edits: { text: string; entities?: MessageEntity[] }[] = [];
    const relay = createRelay({
      edit: async (text, entities) => edits.push({ text, entities }),
      debounceMs: 9999,
    });

    relay.onDelta("Part 1. ");
    relay.onDelta("thinking 1", 'thinking');
    relay.onDelta(" Part 2. ");
    relay.onDelta("thinking 2", 'thinking');
    await relay.onDone();

    const entities = edits[0]!.entities!;
    const bqEntities = entities.filter((e) => e.type === "blockquote");
    expect(bqEntities.length).toBe(2);

    expect(bqEntities[0]!.offset).toBe(8); // after "Part 1. "
    expect(bqEntities[0]!.length).toBe("thinking 1".length);

    expect(bqEntities[1]!.offset).toBe(8 + "thinking 1".length + " Part 2. ".length);
    expect(bqEntities[1]!.length).toBe("thinking 2".length);
  });
});
