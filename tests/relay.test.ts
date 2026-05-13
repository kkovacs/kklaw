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
});
