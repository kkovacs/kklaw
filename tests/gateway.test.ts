import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, extFromMime } from "../index";
import { formatToolCall, type TelegramApi, type MessageContext, type PhotoMessageContext, type DocumentMessageContext } from "../telegram";
import { loadFixtureLines } from "./helpers";
import type { PiClient } from "../pi-client";

function mockApi(): TelegramApi {
  return {
    sendMessage: async () => ({ message_id: 42 }),
    editMessageText: async () => ({}),
    sendChatAction: async () => ({}),
    getFile: async () => ({ file_path: "test/photo.jpg" }),
    deleteMessage: async () => ({}),
  };
}

function mockContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 123,
    from: { id: 8476228873 },
    msg: { text: "hello pi" },
    reply: async () => {},
    react: async () => {},
    ...overrides,
  };
}

function mockPhotoContext(overrides: Partial<PhotoMessageContext> = {}): PhotoMessageContext {
  return {
    chatId: 123,
    from: { id: 8476228873 },
    msg: {
      caption: "what's in this photo",
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 100, height: 100, file_size: 1000 },
        { file_id: "large", file_unique_id: "u2", width: 800, height: 600, file_size: 50000 },
      ],
    },
    reply: async () => {},
    react: async () => {},
    ...overrides,
  };
}

function mockDocumentContext(overrides: Partial<DocumentMessageContext> = {}): DocumentMessageContext {
  return {
    chatId: 123,
    from: { id: 8476228873 },
    msg: {
      caption: "what's in this doc",
      document: {
        file_id: "doc_file_id",
        mime_type: "image/png",
        file_name: "photo.png",
      },
    },
    reply: async () => {},
    react: async () => {},
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
  });

  it("queues message and reacts with hourglass when pi is busy", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true; // simulate busy

    const ctx = mockContext({ msg: { text: "second msg" } });
    const reactions: string[] = [];
    ctx.react = async (emoji: string) => { reactions.push(emoji); };

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.queue.length).toBe(1);
    expect(gateway.queue[0]!.text).toBe("second msg");
    expect(reactions).toEqual(["👀"]);
  });

  it("passes unknown slash commands to Pi as prompts", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    const ctx = mockContext({ msg: { text: "/skill:test" } });

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
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


});

describe("Gateway.sendTyping", () => {
  it("sends sendChatAction with 'typing'", () => {
    const actions: [number | string, string][] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (chatId, action) => { actions.push([chatId, action]); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendTyping(123);

    expect(actions).toEqual([[123, "typing"]]);
  });

  it("respects 4s cooldown on back-to-back calls", () => {
    let count = 0;
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async () => { count++; },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendTyping(123);
    gateway.sendTyping(123);
    gateway.sendTyping(123);

    expect(count).toBe(1);
  });

  it("sends again after cooldown expires", () => {
    const actions: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (_c, a) => { actions.push(a); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendTyping(123);
    expect(actions).toEqual(["typing"]);

    gateway.lastTypingSent = Date.now() - 5000;
    gateway.sendTyping(123);
    expect(actions).toEqual(["typing", "typing"]);
  });
});

describe("formatToolCall", () => {
  it("formats tool name and args as <pre> HTML", () => {
    const result = formatToolCall({ command: "ls -la" }, "bash");
    expect(result).toBe('<pre>\uD83D\uDD27 bash: {"command":"ls -la"}</pre>');
  });

  it("formats tool without args", () => {
    const result = formatToolCall(undefined, "unknown_tool");
    expect(result).toBe('<pre>\uD83D\uDD27 unknown_tool</pre>');
  });

  it("formats tool with null args", () => {
    const result = formatToolCall(null, "bash");
    expect(result).toBe('<pre>\uD83D\uDD27 bash</pre>');
  });

  it("truncates long args at 250 chars with ...", () => {
    const longCmd = "x".repeat(300);
    const result = formatToolCall({ command: longCmd }, "bash");
    expect(result.length).toBeLessThanOrEqual(300); // <pre>🔧 bash:  + 250-chars json + </pre>
    expect(result).toContain("...");
    expect(result).toEndWith('</pre>');
  });

  it("HTML-escapes <, >, & in tool name", () => {
    const result = formatToolCall({}, "<bash> & stuff");
    expect(result).toContain("&lt;bash&gt; &amp; stuff");
  });

  it("HTML-escapes <, >, & in args JSON", () => {
    const result = formatToolCall({ path: "src/<foo> & bar.txt" }, "read");
    expect(result).toContain("src/&lt;foo&gt; &amp; bar.txt");
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

    await gateway.handlePiEvent({ type: "message_start", message: { role: "assistant" } });
    expect(gateway.currentRelay).not.toBeNull();

    gateway.handlePiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });

    // Debounce hasn't fired yet
    expect(edits).toEqual([]);

    // Force flush by calling onDone (simulates message_end)
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
    await gateway.handlePiEvent({ type: "agent_end" });

    expect(gateway.piStreaming).toBe(true); // second session started
    expect(gateway.queue.length).toBe(0);
  });

  it("sends tool summary on agent_end with tool counts", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 100 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0; // ignore "..." placeholder

    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "read" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "write" });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({ type: "agent_end" });

    expect(sent.length).toBe(1);
    expect(sent[0]).toBe("\uD83D\uDD27 5 tools used: bash \u00d73, read, write");
  });

  it("sends no tool summary when no tools were called", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 100 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({ type: "agent_end" });

    expect(sent.length).toBe(0);
  });

  it("accumulates tool counts across multiple turns", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 100 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "read" });
    gateway.handlePiEvent({ type: "turn_end" });

    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "grep" });
    gateway.handlePiEvent({ type: "turn_end" });

    await gateway.handlePiEvent({ type: "agent_end" });

    expect(sent.length).toBe(1);
    expect(sent[0]).toBe("\uD83D\uDD27 4 tools used: bash \u00d72, grep, read");
  });

  it("clears tool counts after agent_end sends summary", async () => {
    const gateway = new Gateway({
      allowedUserId: 1,
      api: {
        sendMessage: async () => ({ message_id: 100 }),
        editMessageText: async () => ({}),
      },
    });
    await gateway.startPiSession(123, "test");

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    await gateway.handlePiEvent({ type: "agent_end" });

    expect(gateway.turnToolCounts.size).toBe(0);
  });

  it("clears turnToolCounts on resetSession", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(gateway.turnToolCounts.size).toBe(1);

    gateway.resetSession("test");
    expect(gateway.turnToolCounts.size).toBe(0);
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
    await gateway.handlePiEvent({ type: "message_start", message: { role: "assistant" } });
    await gateway.handlePiEvent({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "provider validation failed" },
    });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({
      type: "agent_end",
      messages: [{ stopReason: "error", errorMessage: "provider validation failed" }],
    });

    expect(edits.length).toBe(1);
    expect(edits[0]!.text).toBe("❌ Error: provider validation failed");
    expect(gateway.piStreaming).toBe(false);
  });

  it("bubbles Pi errors via sendMessage when no placeholder was ever created", async () => {
    const sent: { chatId: number | string; text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 77 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    // model rejects before any assistant message_start — no placeholder created
    gateway.handlePiEvent({ type: "agent_start" });
    gateway.handlePiEvent({ type: "turn_start" });
    await gateway.handlePiEvent({ type: "message_end", message: { stopReason: "error", errorMessage: "provider validation failed" } });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({
      type: "agent_end",
      messages: [{ stopReason: "error", errorMessage: "provider validation failed" }],
    });

    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toBe("❌ Error: provider validation failed");
    expect(gateway.piStreaming).toBe(false);
  });

  it("triggers sendTyping on events that mean Pi is working", async () => {
    const typingCalls: number[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => ({}),
      sendChatAction: async (chatId) => { typingCalls.push(chatId as number); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    gateway.handlePiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "message_end" });
    gateway.handlePiEvent({ type: "message_start" });
    gateway.handlePiEvent({ type: "turn_start" });

    expect(typingCalls.length).toBe(1); // cooldown skips subsequent events
    expect(typingCalls[0]).toBe(123);
  });

  it("does NOT send typing on response event", async () => {
    const actions: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (_c, a) => { actions.push(a); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.currentChatId = 123;

    gateway.handlePiEvent({ type: "response", command: "get_state", success: true, data: {} });

    expect(actions).toEqual([]);
  });

  it("does NOT send typing on agent_end event", async () => {
    const actions: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (_c, a) => { actions.push(a); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.currentChatId = 123;

    await gateway.handlePiEvent({ type: "agent_end" });

    expect(actions).toEqual([]);
  });

  it("does NOT send typing when currentChatId is 0 (no active session)", () => {
    const actions: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (_c, a) => { actions.push(a); },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.currentChatId = 0;

    gateway.handlePiEvent({ type: "message_start" });

        expect(actions).toEqual([]);
  });

  it("counts tools in turnToolCounts", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });

    expect(gateway.turnToolCounts.get("bash")).toBe(1);
  });

  it("stores currentSessionId from get_state response", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; },
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;
    expect(gateway.currentSessionId).toBe(null);

    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: { sessionId: "sid-1", sessionFile: "sid-1.jsonl", model: { provider: "p", id: "m" } },
    });

    expect(gateway.currentSessionId).toBe("sid-1");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("sid-1");
  });

  it("leaves currentSessionId null when get_state has no sessionId", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;
    gateway.currentSessionId = "old";

    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: {},
    });

    expect(gateway.currentSessionId).toBe("old");
  });

  it("get_state response does NOT trigger file deletion", async () => {
    let deleted = false;
    const gateway = new Gateway({ allowedUserId: 1, api: mockApi() });
    gateway.deleteFile = async () => { deleted = true; };
    gateway.lastChatId = 123;
    gateway.currentSessionId = "sid-1";
    gateway.sessionPicker.set("sid-1", { path: "/fake/sid-1.jsonl", id: "sid-1", created: "2026-05-15T00:00:00.000Z", mtime: 1 });

    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: { sessionId: "sid-2" },
    });

    expect(deleted).toBe(false);
    expect(gateway.currentSessionId).toBe("sid-2");
  });

  it("preserves currentSessionId through delete flow: stored → reset clears → get_state restores", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 123;

    // Simulate normal operation: a previous get_state stored the session ID
    gateway.currentSessionId = "old-sid";
    gateway.sessionPicker.set("old-sid", { path: "/tmp/old.jsonl", id: "old-sid", created: "2026-01-01T00:00:00.000Z", mtime: 1 });

    // Simulate /delete: read stored ID, delete, reset, then new_session + get_state
    const sessionId = gateway.currentSessionId;
    expect(sessionId).toBe("old-sid");

    gateway.resetSession("/delete");
    expect(gateway.currentSessionId).toBeNull();

    // Simulate get_state response for the new session
    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: { sessionId: "new-sid", model: { provider: "p", id: "m" } },
    });

    expect(gateway.currentSessionId).toBe("new-sid");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("new-sid");
  });

  it("stores currentSessionId on /new flow: resetSession → get_state", async () => {
    const gateway = new Gateway({ allowedUserId: 1, api: mockApi() });
    gateway.lastChatId = 123;
    expect(gateway.currentSessionId).toBeNull();

    gateway.resetSession("/new");
    expect(gateway.currentSessionId).toBeNull();

    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: { sessionId: "new-sid", model: { provider: "p", id: "m" } },
    });

    expect(gateway.currentSessionId).toBe("new-sid");
  });

  it("stores currentSessionId on /resume flow: switchToSession (resetSession) → get_state", async () => {
    const gateway = new Gateway({ allowedUserId: 1, api: mockApi() });
    gateway.sendPi = () => {};
    gateway.lastChatId = 123;
    gateway.currentSessionId = "old-sid";
    gateway.sessionPicker.set("target", { path: "/tmp/t.jsonl", id: "target", created: "2026-01-01T00:00:00.000Z", mtime: 1 });

    gateway.switchToSession("target");
    expect(gateway.currentSessionId).toBeNull();

    await gateway.handlePiEvent({
      type: "response", command: "get_state", success: true,
      data: { sessionId: "new-sid" },
    });

    expect(gateway.currentSessionId).toBe("new-sid");
  });
});

describe("Integration: replay recorded fixture", () => {
  it("replays hello-robot.jsonl and produces expected final text", async () => {
    const lines = loadFixtureLines("hello-robot.jsonl");

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
      await gateway.handlePiEvent(event as Parameters<typeof gateway.handlePiEvent>[0]);
    }

    // Wait for any remaining async work after agent_end
    await new Promise((r) => setTimeout(r, 50));

    expect(gateway.piStreaming).toBe(false);
    expect(edits.length).toBeGreaterThan(0);

    const expected =
      "\n\nHello\\! I'm here to help with your kklaw project \\- the Telegram ↔ Pi RPC Gateway\\.\n" +
      "\n" +
      "What would you like to work on? I can help with:\n" +
      "\\- Reading or editing code files\n" +
      "\\- Running commands\n" +
      "\\- Understanding the codebase\n" +
      "\\- Fixing bugs or adding features\n" +
      "\\- Running tests\n" +
      "\n" +
      "Just let me know what you need\\!";
    expect(edits[edits.length - 1]).toBe(expected);
  });
});

describe("Gateway.resetSession", () => {
  it("clears relay, queue, and streaming state", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.queue.push({ chatId: 123, text: "pending" });
    await gateway.startPiSession(123, "active");
    expect(gateway.currentRelay).toBeNull();

    gateway.resetSession("test");

    expect(gateway.piStreaming).toBe(false);
    expect(gateway.queue.length).toBe(0);
    expect(gateway.currentRelay).toBeNull();
  });

  it("clears currentSessionId", () => {
    const gateway = new Gateway({ allowedUserId: 1, api: mockApi() });
    gateway.currentSessionId = "sid-42";
    gateway.resetSession("test");
    expect(gateway.currentSessionId).toBeNull();
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

describe("Gateway.showStats", () => {
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
    expect(messages[0]!.text).toContain("🔧 Tool calls:    2 / results: 2");
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

describe("Gateway.showDaemonStatus", () => {
  it("formats daemon status as HTML <pre> and sends message", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showDaemonStatus(456);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
    expect(messages[0]!.text).toContain("Kklaw Daemon");
    expect(messages[0]!.text).toContain("Uptime:");
    expect(messages[0]!.text).toContain("not connected");
    expect(messages[0]!.text).toContain("idle");
    expect(messages[0]!.text).toContain("Queue depth:");
  });

  it("shows running Pi with pid when piClient is connected", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.piClient = { pid: 12345, send: () => {}, close: () => {} };

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("running (pid=12345)");
  });

  it("shows busy when piStreaming is true", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.piStreaming = true;

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("busy");
  });

  it("shows queue depth when messages are queued", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.queue = [{ chatId: 123, text: "a" }, { chatId: 123, text: "b" }, { chatId: 123, text: "c" }];

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("Queue depth:  3");
  });

});

describe("Gateway.showLastMessage (/last)", () => {
  it("sends last assistant text with MarkdownV2 escaping", async () => {
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
    expect(messages[0]!.text).toBe("Got it, just testing the waters\\.");
    expect(messages[0]!.other).toEqual({ parse_mode: "MarkdownV2" });
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
    expect(messages[0]!.text).toBe("💬 (No assistant messages yet.)");
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

describe("Gateway.showModels", () => {
  it("formats all models as HTML <pre> when no filter set", async () => {
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
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, input: ["text", "image"], cost: { input: 3, output: 15 } },
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 256000, input: ["text"], cost: { input: 0.5, output: 2 } },
      ],
    };

    await gateway.showModels(456, data);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("</pre>");
    expect(messages[0]!.text).toContain("Available models (2)");
    expect(messages[0]!.text).toContain("anthropic/claude-sonnet-4-20250514");
    expect(messages[0]!.text).toContain("Claude Sonnet 4");
    expect(messages[0]!.text).toContain("200K");
    expect(messages[0]!.text).toContain("📝🏙️");
    expect(messages[0]!.text).toContain("$3/15");
    expect(messages[0]!.text).toContain("opencode-go/minimax-m2.5");
    expect(messages[0]!.text).toContain("256K");
    expect(messages[0]!.text).toContain("📝");
    expect(messages[0]!.text).toContain("$0.5/2");
  });

  it("shows filtered buttons when modelFilter is set", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.modelFilter = "claUde"; // case-insensitive

    const data = {
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" },
      ],
    };

    await gateway.showModels(456, data);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.text).toContain('"claude"');
    const ik = (messages[0] as any).other?.reply_markup?.inline_keyboard;
    expect(ik).toBeDefined();
    expect(ik.length).toBe(1);
    expect(ik[0][0].text).toBe("anthropic/claude-sonnet-4-20250514");
    expect(ik[0][0].callback_data).toBe("model:anthropic/claude-sonnet-4-20250514");
    expect(gateway.modelFilter).toBeUndefined();
  });

  it("filters by model id as well as name", async () => {
    const messages: any[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, _t, other) => { messages.push(other); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.modelFilter = "minimax";

    const data = {
      models: [
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      ],
    };

    await gateway.showModels(1, data);

    const ik = (messages[0] as any)?.reply_markup?.inline_keyboard;
    expect(ik).toBeDefined();
    expect(ik.length).toBe(1);
    expect(ik[0][0].text).toBe("opencode-go/minimax-m2.5");
  });

  it("shows no-match message when filter matches nothing", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.modelFilter = "nonexistent";

    const data = { models: [{ provider: "x", id: "y", name: "Test" }] };

    await gateway.showModels(1, data);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe('No models matching "nonexistent".');
    expect(gateway.modelFilter).toBeUndefined();
  });

  it("shows empty message when no models available", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    await gateway.showModels(1, { models: [] });

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("No models available.");
  });

  it("shows emoji for image, audio, video modalities", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    const data = {
      models: [
        { provider: "x", id: "multi", name: "Multi", contextWindow: 100000, input: ["text", "image", "audio", "video"], cost: { input: 1, output: 2 } },
      ],
    };

    await gateway.showModels(1, data);

    expect(messages[0]!.text).toContain("📝🏙️🎤🎬");
    expect(messages[0]!.text).toContain("100K");
    expect(messages[0]!.text).toContain("$1/2");
  });

  it("handles models with missing optional fields", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    const data = {
      models: [{ provider: "x", id: "y" }],
    };

    await gateway.showModels(1, data);

    expect(messages[0]!.text).toContain("x/y — y");
    expect(messages[0]!.text).toContain("?");
  });

  it("splits into multiple messages when list exceeds Telegram limit", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });

    const longName = "A".repeat(100);
    const models: any[] = [];
    for (let i = 0; i < 40; i++) {
      models.push({
        provider: "p",
        id: `m${i}`,
        name: longName,
        contextWindow: 100000,
        input: ["text"],
        cost: { input: 1, output: 2 },
      });
    }

    await gateway.showModels(1, { models });

    expect(messages.length).toBeGreaterThan(1);
    for (const msg of messages) {
      expect(msg.text).toContain("<pre>");
      expect(msg.text).toContain("</pre>");
    }
    expect(messages[0]!.text).toContain("Available models (40)");
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

  it("routes get_session_stats response to showStats when lastChatId is set", async () => {
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

  it("routes get_available_models response to showModels when lastChatId is set", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"x","id":"y","name":"Test","contextWindow":100000,"input":["text"],"cost":{"input":1,"output":2}}]}}
    `));

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("x/y");
    expect(messages[0]!.text).toContain("Test");
  });

  it("does NOT route get_available_models response when lastChatId is 0", async () => {
    let called = false;
    const api: TelegramApi = {
      sendMessage: async () => { called = true; return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 0;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"get_available_models","success":true,"data":{"models":[]}}
    `));

    expect(called).toBe(false);
  });

  it("routes bash response via lastChatId, sending output as <pre> chunks", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 789;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"bash","success":true,"data":{"output":"hello from bash","exitCode":0}}
    `));

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("hello from bash");
    expect(messages[0]!.text).toContain("Exit code: 0");
  });

  it("does NOT route bash response when lastChatId is 0", async () => {
    let called = false;
    const api: TelegramApi = {
      sendMessage: async () => { called = true; return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.lastChatId = 0;

    gateway.handlePiEvent(JSON.parse(`
      {"type":"response","command":"bash","success":true,"data":{"output":"hi","exitCode":0}}
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
    expect(messages[0]!.text).toContain("📁 Session file:");
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
    expect(messages[0]!.other).toEqual({ parse_mode: "MarkdownV2" });
    expect(messages[0]!.text).toContain("Got it, just testing the waters\\.");
    expect(messages[0]!.text).toContain("Ready when you need me for anything kklaw\\-related\\!");
  });
});

// ============================================================
// Session fixture helpers
// ============================================================

function writeSessionFile(dir: string, relPath: string, lines: string[], mtime: Date): void {
  const path = join(dir, relPath);
  const parent = join(path, "..");
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  utimesSync(path, mtime, mtime);
}

function setupSessionFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "kklaw-test-sessions-"));

  // Session 1: named "fix-auth-bug", newest
  writeSessionFile(dir, "2026-04-12T15-40-00-000Z_01999999-1111-7aaa-bbbb-ccccddddeeee.jsonl", [
    '{"type":"session","version":3,"id":"01999999-1111-7aaa-bbbb-ccccddddeeee","timestamp":"2026-04-12T15:40:00.000Z","cwd":"/home/user/proj1"}',
    '{"type":"session_info","id":"a1b2c3d4","parentId":null,"timestamp":"2026-04-12T15:41:00.000Z","name":"fix-auth-bug"}',
    '{"type":"message","id":"e5f6a7b8","parentId":null,"timestamp":"2026-04-12T15:40:01.000Z","message":{"role":"user","content":"fix the auth bug"}}',
  ], new Date(2026, 3, 12, 15, 40));

  // Session 2: unnamed
  writeSessionFile(dir, "2026-04-11T09-15-00-000Z_01999999-2222-7aaa-bbbb-ccccddddffff.jsonl", [
    '{"type":"session","version":3,"id":"01999999-2222-7aaa-bbbb-ccccddddffff","timestamp":"2026-04-11T09:15:00.000Z","cwd":"/home/user/proj1"}',
    '{"type":"message","id":"b2c3d4e5","parentId":null,"timestamp":"2026-04-11T09:15:01.000Z","message":{"role":"user","content":"hello"}}',
  ], new Date(2026, 3, 11, 9, 15));

  // Session 3: named "refactor", oldest
  writeSessionFile(dir, "2026-04-10T08-00-00-000Z_01999999-3333-7aaa-bbbb-ccccddddgggg.jsonl", [
    '{"type":"session","version":3,"id":"01999999-3333-7aaa-bbbb-ccccddddgggg","timestamp":"2026-04-10T08:00:00.000Z","cwd":"/home/user/proj2"}',
    '{"type":"session_info","id":"f6a7b8c9","parentId":null,"timestamp":"2026-04-10T08:01:00.000Z","name":"refactor"}',
    '{"type":"message","id":"c3d4e5f6","parentId":null,"timestamp":"2026-04-10T08:00:01.000Z","message":{"role":"user","content":"refactor the module"}}',
  ], new Date(2026, 3, 10, 8, 0));

  // Session 4: unnamed, in subdir (recursion test)
  writeSessionFile(dir, "subdir/2026-04-09T12-00-00-000Z_01999999-4444-7aaa-bbbb-ccccddddhhhh.jsonl", [
    '{"type":"session","version":3,"id":"01999999-4444-7aaa-bbbb-ccccddddhhhh","timestamp":"2026-04-09T12:00:00.000Z","cwd":"/home/user/proj3"}',
    '{"type":"message","id":"d4e5f6a7","parentId":null,"timestamp":"2026-04-09T12:00:01.000Z","message":{"role":"user","content":"work in subdir"}}',
  ], new Date(2026, 3, 9, 12, 0));

  // Bogus file: no session header, should be filtered out
  writeSessionFile(dir, "bogus.jsonl", [
    '{"type":"not-a-session","foo":"bar"}',
  ], new Date(2026, 3, 13, 0, 0));

  return dir;
}

// ============================================================
// Session scanning tests
// ============================================================

describe("Gateway.scanRecentSessions", () => {
  it("sorts sessions by mtime (newest first) and extracts names", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const sessions = gateway.scanRecentSessions(10, sessionsDir);

    // Sorted: newest (fix-auth-bug) → oldest (subdir)
    expect(sessions[0]!.id).toBe("01999999-1111-7aaa-bbbb-ccccddddeeee");
    expect(sessions[0]!.name).toBe("fix-auth-bug");
    expect(sessions[1]!.id).toBe("01999999-2222-7aaa-bbbb-ccccddddffff");
    expect(sessions[1]!.name).toBeUndefined();
    expect(sessions[2]!.id).toBe("01999999-3333-7aaa-bbbb-ccccddddgggg");
    expect(sessions[2]!.name).toBe("refactor");
  });

  it("filters out files without a valid session header", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const sessions = gateway.scanRecentSessions(10, sessionsDir);

    // 5 files total, but bogus.jsonl has no session header → only 4 returned
    expect(sessions.length).toBe(4);
  });

  it("recurses into subdirectories", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const sessions = gateway.scanRecentSessions(10, sessionsDir);

    const subdirSession = sessions.find(s => s.id === "01999999-4444-7aaa-bbbb-ccccddddhhhh");
    expect(subdirSession).not.toBeUndefined();
    expect(subdirSession!.path).toContain("subdir/");
  });

  it("populates sessionPicker map", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    gateway.scanRecentSessions(10, sessionsDir);

    expect(gateway.sessionPicker.size).toBe(4);
    const info = gateway.sessionPicker.get("01999999-1111-7aaa-bbbb-ccccddddeeee");
    expect(info).not.toBeUndefined();
    expect(info!.name).toBe("fix-auth-bug");
    expect(info!.path).toContain("01999999-1111-7aaa-bbbb-ccccddddeeee.jsonl");
  });

  it("handles empty directory", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const emptyDir = mkdtempSync(join(tmpdir(), "kklaw-test-empty-"));

    const sessions = gateway.scanRecentSessions(10, emptyDir);

    expect(sessions.length).toBe(0);
    expect(gateway.sessionPicker.size).toBe(0);
  });

  it("handles nonexistent directory", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });

    const sessions = gateway.scanRecentSessions(10, "/nonexistent/path/xyz");

    expect(sessions.length).toBe(0);
    expect(gateway.sessionPicker.size).toBe(0);
  });
});

// ============================================================
// Session switching tests
// ============================================================

describe("Gateway.switchToSession", () => {
  it("sends switch_session RPC when session is in picker", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const piCommands: Record<string, unknown>[] = [];
    const mockPi: PiClient = {
      pid: 1,
      send(cmd) { piCommands.push(cmd); },
      close() {},
    };
    gateway.piClient = mockPi;

    gateway.scanRecentSessions(10, sessionsDir);
    const sessionId = "01999999-2222-7aaa-bbbb-ccccddddffff";

    gateway.switchToSession(sessionId);

    expect(piCommands.length).toBe(1);
    expect(piCommands[0]).toEqual({
      type: "switch_session",
      sessionPath: expect.stringContaining("01999999-2222-7aaa-bbbb-ccccddddffff.jsonl"),
    });
  });

  it("does nothing when session is not in picker", () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 1, api });

    const piCommands: Record<string, unknown>[] = [];
    gateway.piClient = {
      pid: 1,
      send(cmd) { piCommands.push(cmd); },
      close() {},
    };

    gateway.switchToSession("nonexistent-id");

    expect(piCommands.length).toBe(0);
  });
});

// ============================================================
// Integration: session switch then /last
// ============================================================

describe("Integration: /resume then /last", () => {
  it("switches session and then /last returns correct text", async () => {
    const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text, other) => {
        messages.push({ chatId, text, other });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    };

    const piCommands: Record<string, unknown>[] = [];
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.piClient = {
      pid: 1,
      send(cmd) { piCommands.push(cmd); },
      close() {},
    };

    const sessionsDir = setupSessionFixtures();
    gateway.scanRecentSessions(10, sessionsDir);

    // Switch to the first session
    const sessionId = "01999999-1111-7aaa-bbbb-ccccddddeeee";
    gateway.switchToSession(sessionId);

    expect(piCommands).toEqual([{
      type: "switch_session",
      sessionPath: expect.stringContaining("01999999-1111-7aaa-bbbb-ccccddddeeee.jsonl"),
    }]);

    // Now simulate /last command
    gateway.lastChatId = 789;
    gateway.handlePiEvent({
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: { text: "The auth bug is fixed." },
    });

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(789);
    expect(messages[0]!.text).toBe("The auth bug is fixed\\.");
  });
});

describe("Gateway.handlePhotoMessage", () => {
  it("rejects unauthorized user", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 999, api });
    gateway.downloadFile = async () => Buffer.from("fake");
    const ctx = mockPhotoContext({ from: { id: 111 } });
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handlePhotoMessage(ctx, api);

    expect(gateway.queue.length).toBe(0);
    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("starts a session with caption and image when pi is idle", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("test");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockPhotoContext();
    await gateway.handlePhotoMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
    expect(piCommands).toEqual([{
      type: "prompt",
      message: "what's in this photo",
      images: [{
        type: "image",
        data: Buffer.from("test").toString("base64"),
        mimeType: "image/jpeg",
      }],
    }]);
  });

  it("uses empty message when photo has no caption", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("img");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockPhotoContext({ msg: { caption: undefined, photo: mockPhotoContext().msg.photo } });
    await gateway.handlePhotoMessage(ctx, api);

    expect(piCommands[0]).toHaveProperty("message", "");
    expect(piCommands[0]).toHaveProperty("images");
  });

  it("picks the largest photo by file_size", async () => {
    const downloadedIds: string[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async (fileId) => { downloadedIds.push(fileId); return Buffer.from("img"); };
    gateway.sendPi = () => {};

    const ctx = mockPhotoContext({
      msg: {
        caption: undefined,
        photo: [
          { file_id: "tiny", file_unique_id: "u1", width: 10, height: 10, file_size: 100 },
          { file_id: "big", file_unique_id: "u2", width: 800, height: 600, file_size: 99999 },
          { file_id: "mid", file_unique_id: "u3", width: 320, height: 240, file_size: 5000 },
        ],
      },
    });
    await gateway.handlePhotoMessage(ctx, api);

    expect(downloadedIds).toEqual(["big"]);
  });

  it("replies 'Failed to download photo.' on download error", async () => {
    const replies: string[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => { throw new Error("network down"); };

    const ctx = mockPhotoContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(replies).toEqual(["Failed to download photo."]);
    expect(gateway.piStreaming).toBe(false);
    expect(gateway.queue.length).toBe(0);
  });

  it("queues message with images when pi is busy", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.downloadFile = async () => Buffer.from("busy-img");
    const reactions: string[] = [];
    const ctx = mockPhotoContext();
    ctx.react = async (emoji) => { reactions.push(emoji); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(gateway.queue.length).toBe(1);
    expect(gateway.queue[0]!.text).toBe("what's in this photo");
    expect(gateway.queue[0]!.images).toEqual([{
      type: "image",
      data: Buffer.from("busy-img").toString("base64"),
      mimeType: "image/jpeg",
    }]);
    expect(reactions).toEqual(["👀"]);
  });

  it("replies with saved filename after photo download", async () => {
    const piCommands: object[] = [];
    const replies: string[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("photo-data");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };
    gateway.saveUpload = async () => "1747380800000.jpeg";

    const ctx = mockPhotoContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(replies).toEqual(["📎 Saved: 1747380800000.jpeg"]);
    expect(piCommands.length).toBe(1);
  });

  it("processQueue dequeues message with images and starts session", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("img");
    gateway.sendPi = () => {};

    gateway.queue.push({
      chatId: 123,
      text: "see this",
      images: [{ type: "image", data: "aa==", mimeType: "image/png" }],
    });
    gateway.piStreaming = false;

    gateway.processQueue(api);

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.queue.length).toBe(0);
  });

  it("startPiSession includes images in RPC command", async () => {
    const piCommands: object[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 11 }),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    await gateway.startPiSession(123, "look", api, [
      { type: "image", data: "bb==", mimeType: "image/png" },
    ]);

    expect(piCommands).toEqual([{
      type: "prompt",
      message: "look",
      images: [{ type: "image", data: "bb==", mimeType: "image/png" }],
    }]);
  });

  it("startPiSession omits images when empty array", async () => {
    const piCommands: object[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 12 }),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    await gateway.startPiSession(123, "hello", api, []);

    expect(piCommands).toEqual([{
      type: "prompt",
      message: "hello",
    }]);
  });

  it("startPiSession omits images when undefined", async () => {
    const piCommands: object[] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 13 }),
    };
    const gateway = new Gateway({ allowedUserId: 1, api });
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    await gateway.startPiSession(123, "hello", api);

    expect(piCommands).toEqual([{
      type: "prompt",
      message: "hello",
    }]);
  });
});

describe("Gateway.handleDocumentMessage", () => {
  it("rejects unauthorized user", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 999, api });
    gateway.downloadFile = async () => Buffer.from("fake");
    const ctx = mockDocumentContext({ from: { id: 111 } });
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.queue.length).toBe(0);
    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("sends non-image documents as text prompts", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("pdf");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockDocumentContext({
      msg: { document: { file_id: "f1", mime_type: "application/pdf", file_name: "doc.pdf" } },
    });
    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
    expect(piCommands).toEqual([{ type: "prompt", message: "" }]);
  });

  it("ignores document with missing file_id", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockDocumentContext({ msg: { document: undefined } });
    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(piCommands).toEqual([]);
  });

  it("starts a session with caption and image when pi is idle", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("docdata");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockDocumentContext();
    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
    expect(piCommands).toEqual([{
      type: "prompt",
      message: "what's in this doc",
      images: [{
        type: "image",
        data: Buffer.from("docdata").toString("base64"),
        mimeType: "image/png",
      }],
    }]);
  });

  it("uses empty message when document has no caption", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("img");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockDocumentContext({ msg: { caption: undefined, document: mockDocumentContext().msg.document } });
    await gateway.handleDocumentMessage(ctx, api);

    expect(piCommands[0]).toHaveProperty("message", "");
    expect(piCommands[0]).toHaveProperty("images");
  });

  it("uses the document's actual MIME type", async () => {
    const piCommands: object[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("webp");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };

    const ctx = mockDocumentContext({
      msg: { document: { file_id: "f1", mime_type: "image/webp", file_name: "sticker.webp" } },
    });
    await gateway.handleDocumentMessage(ctx, api);

    expect(piCommands[0]).toHaveProperty("images", [{
      type: "image",
      data: Buffer.from("webp").toString("base64"),
      mimeType: "image/webp",
    }]);
  });

  it("replies 'Failed to download document.' on download error", async () => {
    const replies: string[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => { throw new Error("network down"); };

    const ctx = mockDocumentContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleDocumentMessage(ctx, api);

    expect(replies).toEqual(["Failed to download document."]);
    expect(gateway.piStreaming).toBe(false);
    expect(gateway.queue.length).toBe(0);
  });

  it("replies with saved filename after document download", async () => {
    const piCommands: object[] = [];
    const replies: string[] = [];
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("doc-data");
    gateway.sendPi = (cmd) => { piCommands.push(cmd); };
    gateway.saveUpload = async () => "report.csv";

    const ctx = mockDocumentContext({
      msg: { document: { file_id: "f1", mime_type: "image/png", file_name: "report.csv" } },
    });
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleDocumentMessage(ctx, api);

    expect(replies).toEqual(["📎 Saved: report.csv"]);
    expect(piCommands.length).toBe(1);
  });

  it("queues message with images when pi is busy", async () => {
    const api = mockApi();
    const gateway = new Gateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.downloadFile = async () => Buffer.from("busy-doc");
    const reactions: string[] = [];
    const ctx = mockDocumentContext();
    ctx.react = async (emoji) => { reactions.push(emoji); };

    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.queue.length).toBe(1);
    expect(gateway.queue[0]!.text).toBe("what's in this doc");
    expect(gateway.queue[0]!.images).toEqual([{
      type: "image",
      data: Buffer.from("busy-doc").toString("base64"),
      mimeType: "image/png",
    }]);
    expect(reactions).toEqual(["👀"]);
  });
});

describe("extFromMime", () => {
  it("extracts common image extensions", () => {
    expect(extFromMime("image/jpeg")).toBe(".jpeg");
    expect(extFromMime("image/png")).toBe(".png");
    expect(extFromMime("image/gif")).toBe(".gif");
    expect(extFromMime("image/webp")).toBe(".webp");
  });

  it("handles svg+xml override", () => {
    expect(extFromMime("image/svg+xml")).toBe(".svg");
  });

  it("extracts application extensions", () => {
    expect(extFromMime("application/pdf")).toBe(".pdf");
    expect(extFromMime("application/zip")).toBe(".zip");
  });

  it("handles octet-stream fallback", () => {
    expect(extFromMime("application/octet-stream")).toBe(".bin");
  });

  it("falls back to .bin for malformed mime", () => {
    expect(extFromMime("")).toBe(".bin");
    expect(extFromMime("no-slash")).toBe(".bin");
  });
});
