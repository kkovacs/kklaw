import { describe, it, expect } from "bun:test";
import { Gateway, type TelegramApi, type MessageContext } from "../index";
import { loadFixtureLines, extractTextDeltas } from "./helpers";

function mockApi(): TelegramApi {
  return {
    sendMessage: async () => ({ message_id: 42 }),
    editMessageText: async () => ({}),
  };
}

function mockContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 123,
    from: { id: 8476228873 },
    msg: { text: "hello pi" },
    reply: async () => {},
    ...overrides,
  };
}

describe("Gateway.handleTextMessage", () => {
  it("rejects unauthorized user", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 999, api });
    const ctx = mockContext();
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.queue.length).toBe(0);
    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("starts a session for authorized user when pi is idle", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    const ctx = mockContext();

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.queue.length).toBe(0);
    expect(gateway.currentRelay).not.toBeNull();
  });

  it("queues message and replies 'Queued.' when pi is busy", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true; // simulate busy

    const ctx = mockContext({ msg: { text: "second msg" } });
    const replies: string[] = [];
    ctx.reply = async (text: string) => { replies.push(text); };

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.queue.length).toBe(1);
    expect(gateway.queue[0].text).toBe("second msg");
    expect(replies).toEqual(["⏳ Queued."]);
  });

  it("ignores messages starting with /", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    const ctx = mockContext({ msg: { text: "/start" } });

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(gateway.queue.length).toBe(0);
  });
});

describe("Gateway.processQueue", () => {
  it("processes queued messages after pi becomes idle", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.queue.push({ chatId: 123, text: "queued msg" });
    gateway.piStreaming = false;

    gateway.processQueue(api);

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.queue.length).toBe(0);
  });

  it("does nothing when pi is still streaming", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.queue.push({ chatId: 123, text: "queued msg" });
    gateway.piStreaming = true;

    gateway.processQueue(api);

    expect(gateway.queue.length).toBe(1);
    expect(gateway.piStreaming).toBe(true);
  });

  it("does nothing when queue is empty", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = false;

    gateway.processQueue(api);

    expect(gateway.piStreaming).toBe(false);
  });
});

describe("Gateway.handlePiEvent", () => {
  it("streams text_delta through relay", async () => {
    const api = mockApi();
    const edits: string[] = [];
    const gateway = new Gateway({
      allowedUserId: 1,
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async (_c, _m, text) => { edits.push(text); },
      },
    });

    await gateway.startPiSession(123, "test");
    expect(gateway.currentRelay).not.toBeNull();

    gateway.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });

    // Debounce hasn't fired yet
    expect(edits).toEqual([]);

    // Force flush by calling onDone (simulates agent_end)
    await gateway.currentRelay!.onDone();
    expect(edits).toEqual(["hi"]);
  });

  it("clears state on agent_end and processes queue", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });

    // Start a session
    await gateway.startPiSession(123, "first");
    expect(gateway.piStreaming).toBe(true);

    // Queue a second message
    gateway.queue.push({ chatId: 123, text: "second" });

    // Simulate agent_end
    gateway.handlePiEvent({ type: "agent_end" });

    // Wait for async onDone + processQueue
    await new Promise((r) => setTimeout(r, 50));

    expect(gateway.piStreaming).toBe(true); // second session started
    expect(gateway.queue.length).toBe(0);
  });
});

describe("Integration: replay recorded fixture", () => {
  it("replays hello-robot.jsonl and produces expected final text", async () => {
    const lines = loadFixtureLines("hello-robot.jsonl");
    const expectedText = extractTextDeltas(lines);
    expect(expectedText.length).toBeGreaterThan(0);

    const edits: string[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async (_c, _m, text) => { edits.push(text); },
    };

    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "Hello robot!", api);

    for (const line of lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      gateway.handlePiEvent(event as Parameters<typeof gateway.handlePiEvent>[0]);
    }

    // Wait for async onDone + processQueue after agent_end
    await new Promise((r) => setTimeout(r, 50));

    expect(gateway.piStreaming).toBe(false);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[edits.length - 1]).toBe(expectedText);
  });
});
