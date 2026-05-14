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
    expect(gateway.queue[0]!.text).toBe("second msg");
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

  it("streams thinking_delta through relay with blockquote prefix", async () => {
    const edits: { text: string; parse_mode?: unknown }[] = [];
    const gateway = new Gateway({
      allowedUserId: 1,
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async (_c, _m, text, other) => {
          edits.push({ text, parse_mode: other?.parse_mode });
        },
      },
    });

    await gateway.startPiSession(123, "test");
    gateway.showThinking = true;

    gateway.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm..." },
    });

    await gateway.currentRelay!.onDone();

    expect(edits.length).toBe(1);
    expect(edits[0]!.text).toBe("> hmm\\.\\.\\.\n");
    expect(edits[0]!.parse_mode).toBe("MarkdownV2");
  });

  it("drops thinking_delta when showThinking is false (default)", async () => {
    const edits: string[] = [];
    const gateway = new Gateway({
      allowedUserId: 1,
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async (_c, _m, text) => { edits.push(text); },
      },
    });

    await gateway.startPiSession(123, "test");

    // Fire a thinking_delta — should be swallowed
    gateway.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "secret reasoning" },
    });

    // Fire a text_delta — should still come through
    gateway.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "visible answer" },
    });

    await gateway.currentRelay!.onDone();

    // Only the text delta should appear, no thinking blockquote
    expect(edits.length).toBe(1);
    expect(edits[0]).not.toContain("secret reasoning");
    expect(edits[0]).toContain("visible answer");
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
    await gateway.handlePiEvent({ type: "agent_end" });

    expect(gateway.piStreaming).toBe(true); // second session started
    expect(gateway.queue.length).toBe(0);
  });

  it("bubbles Pi errors to Telegram when stream produces no content", async () => {
    const edits: { chatId: number | string; messageId: number; text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 99 }),
      editMessageText: async (chatId, messageId, text) => {
        edits.push({ chatId, messageId, text });
        return {};
      },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    gateway.handlePiEvent({ type: "agent_start" });
    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "message_start" });
    gateway.handlePiEvent({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "provider validation failed" },
    });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({
      type: "agent_end",
      messages: [{ stopReason: "error", errorMessage: "provider validation failed" }],
    });

    expect(edits.length).toBe(1);
    expect(edits[0]!.text).toBe("Error: provider validation failed");
    expect(gateway.piStreaming).toBe(false);
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
    gateway.showThinking = true;
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

describe("Gateway.resetSession", () => {
  it("clears relay, queue, and streaming state", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.queue.push({ chatId: 123, text: "pending" });
    await gateway.startPiSession(123, "active");
    expect(gateway.currentRelay).not.toBeNull();

    gateway.resetSession();

    expect(gateway.piStreaming).toBe(false);
    expect(gateway.queue.length).toBe(0);
    expect(gateway.currentRelay).toBeNull();
  });
});

describe("Gateway.showStatus", () => {
  it("formats get_state response as HTML <pre> and sends message", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    const data = {
      model: { provider: "opencode-go", modelId: "minimax-m2.5" },
      sessionId: "abc123",
      thinkingLevel: "medium",
      messageCount: 5,
      pendingMessageCount: 2,
    };

    await gateway.showStatus(456, data);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
    expect(messages[0]!.text).toContain("opencode-go/minimax-m2.5");
    expect(messages[0]!.text).toContain("abc123");
    expect(messages[0]!.text).toContain("medium");
    expect(messages[0]!.text).toContain("5");
    expect(messages[0]!.text).toContain("(+2 pending)");
  });

  it("shows session name when present", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showStatus(1, {
      model: { provider: "x", modelId: "y" },
      sessionId: "s1",
      sessionName: "My Session",
      thinkingLevel: "off",
      messageCount: 0,
    });

    expect(messages[0]!.text).toContain('("My Session")');
  });
});

describe("Gateway.showStats (/context)", () => {
  it("formats get_session_stats response as HTML <pre> and sends message", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    const data = {
      sessionId: "abc123",
      userMessages: 3,
      assistantMessages: 5,
      toolCalls: 2,
      toolResults: 2,
      totalMessages: 8,
      tokens: { input: 1200, output: 450, cacheRead: 0, cacheWrite: 0, total: 1650 },
      cost: 0.0023,
      sessionFile: "some-session.jsonl",
    };

    await gateway.showStats(456, data);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
    expect(messages[0]!.text).toContain("abc123");
    expect(messages[0]!.text).toContain("user: 3, assistant: 5");
    expect(messages[0]!.text).toContain("Tool calls:    2 / results: 2");
    expect(messages[0]!.text).toContain("1.2K"); // 1200 input
    expect(messages[0]!.text).toContain("450");  // output < 1000, no abbreviation
    expect(messages[0]!.text).toContain("1.6K"); // 1650 total
    expect(messages[0]!.text).toContain("$0.0023");
    expect(messages[0]!.text).toContain("some-session.jsonl");
  });

  it("formats large token counts with M suffix", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showStats(1, {
      sessionId: "x",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 1_500_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0, total: 3_500_000 },
      cost: 5.0,
    });

    expect(messages[0]!.text).toContain("1.5M"); // 1.5M input
    expect(messages[0]!.text).toContain("2.0M"); // 2.0M output
    expect(messages[0]!.text).toContain("3.5M"); // 3.5M total
    expect(messages[0]!.text).toContain("$5.0000");
  });
});

describe("Gateway.showLastMessage (/last)", () => {
  it("sends last assistant text as plain message (no parse_mode)", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showLastMessage(456, {
      text: "Got it, just testing the waters.",
    });

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.text).toBe("Got it, just testing the waters.");
    expect(messages[0]!.other).toBeUndefined();
  });

  it("sends placeholder when text is null (no assistant messages yet)", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showLastMessage(1, { text: null });

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("(No assistant messages yet.)");
  });

  it("sends placeholder when data is undefined", async () => {
    const messages: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push(text); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showLastMessage(1, undefined);

    expect(messages.length).toBe(0);
  });
});

describe("Gateway.handlePiEvent command routing", () => {
  it("routes get_state response to showStatus when lastChatId is set", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"p","modelId":"m"},"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionId":"sid","autoCompactionEnabled":true,"messageCount":1,"pendingMessageCount":0}}
    `));

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("p/m");
    expect(messages[0]!.text).toContain("sid");
  });

  it("routes get_session_stats response to showStats (/context) when lastChatId is set", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_session_stats","success":true,"data":{"sessionId":"sid","userMessages":1,"assistantMessages":2,"toolCalls":0,"toolResults":0,"totalMessages":3,"tokens":{"input":100,"output":200,"cacheRead":0,"cacheWrite":0,"total":300},"cost":0.001}}
    `));

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("sid");
    expect(messages[0]!.text).toContain("user: 1, assistant: 2");
    expect(messages[0]!.text).toContain("$0.0010");
  });

  it("routes get_last_assistant_text response to showLastMessage when lastChatId is set", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_last_assistant_text","success":true,"data":{"text":"the last reply"}}
    `));

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("the last reply");
  });

  it("does NOT route get_state response when lastChatId is 0", async () => {
    let called = false;
    const api: TelegramApi = {
      sendMessage: async () => { called = true; return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 0;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"p","modelId":"m"},"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionId":"sid","autoCompactionEnabled":true,"messageCount":1,"pendingMessageCount":0}}
    `));

    expect(called).toBe(false);
  });

  it("does NOT route other response commands to showStatus", async () => {
    let called = false;
    const api: TelegramApi = {
      sendMessage: async () => { called = true; return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"new_session","success":true,"data":{"cancelled":false}}
    `));

    expect(called).toBe(false);
  });
});

describe("Integration: replay command responses", () => {
  it("replays get-state.jsonl and produces status message", async () => {
    const messages: { text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text, other) => {
        messages.push({ text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;

    const lines = loadFixtureLines("get-state.jsonl");
    for (const line of lines) {
      gateway.handlePiEvent(JSON.parse(line));
    }

    expect(messages.length).toBe(1);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("opencode-go/minimax-m2.5");
    expect(messages[0]!.text).toContain("019e23a4-4c58-71a1-b3b9-6da3b6c97a28");
    expect(messages[0]!.text).toContain("medium");
    expect(messages[0]!.text).toContain("0");
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
  });

  it("replays get-session-stats.jsonl and produces context message", async () => {
    const messages: { text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text, other) => {
        messages.push({ text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;

    const lines = loadFixtureLines("get-session-stats.jsonl");
    for (const line of lines) {
      gateway.handlePiEvent(JSON.parse(line));
    }

    expect(messages.length).toBe(1);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("019e23a4-4c58-71a1-b3b9-6da3b6c97a28");
    expect(messages[0]!.text).toContain("0");
    expect(messages[0]!.text).toContain("$0.0000");
    expect(messages[0]!.text).toContain("Session file:");
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
  });

  it("replays get-last-assistant-text.jsonl and produces last message", async () => {
    const messages: { text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text, other) => {
        messages.push({ text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;

    const lines = loadFixtureLines("get-last-assistant-text.jsonl");
    for (const line of lines) {
      gateway.handlePiEvent(JSON.parse(line));
    }

    expect(messages.length).toBe(1);
    expect(messages[0]!.other).toBeUndefined();
    expect(messages[0]!.text).toContain("Got it, just testing the waters.");
    expect(messages[0]!.text).toContain("Ready when you need me for anything kklaw-related!");
  });
});
