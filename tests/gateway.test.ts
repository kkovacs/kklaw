import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, extFromMime } from "../index";
import { type TelegramApi, type MessageContext, type PhotoMessageContext, type DocumentMessageContext, type VoiceMessageContext } from "../telegram";
import { loadFixtureLines } from "./helpers";
import type { PiResponse } from "../pi-client";

// Bun loads .env for tests too: never let them write into the real UPLOAD_DIR.
// Each test starts with a fresh temp dir; tests that need it unset delete it.
const testUploadRoot = mkdtempSync(join(tmpdir(), "kklaw-test-uploads-"));
beforeEach(() => {
  process.env.UPLOAD_DIR = mkdtempSync(join(testUploadRoot, "u-"));
});
afterAll(() => rmSync(testUploadRoot, { recursive: true, force: true }));

// Gateway with a fake pi: requestPi() records each command and resolves
// successfully (prompt → "started", steer → "queued", like a busy-free pi).
// `respond` overrides fields of the response per command.
type Responder = (cmd: Record<string, unknown>) => Partial<PiResponse> | undefined;
const DEFAULT_DISPOSITION: Record<string, string> = { prompt: "started", steer: "queued" };
function fakePi(gateway: Gateway, respond?: Responder): Record<string, unknown>[] {
  const piCommands: Record<string, unknown>[] = [];
  gateway.requestPi = async (cmd) => {
    piCommands.push(cmd);
    const disposition = DEFAULT_DISPOSITION[String(cmd.type)];
    return {
      type: "response", command: String(cmd.type), success: true,
      ...(disposition ? { data: { disposition } } : {}),
      ...respond?.(cmd),
    };
  };
  return piCommands;
}

function newGateway(options: ConstructorParameters<typeof Gateway>[0]): Gateway {
  const gateway = new Gateway(options);
  fakePi(gateway);
  return gateway;
}

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

function mockVoiceContext(overrides: Partial<VoiceMessageContext> = {}): VoiceMessageContext {
  return {
    chatId: 123,
    from: { id: 8476228873 },
    msg: {
      voice: {
        file_id: "voice_file_id",
        mime_type: "audio/ogg",
        duration: 5,
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
    const gateway = newGateway({ allowedUserId: 999, api });
    const ctx = mockContext();
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("starts a session for authorized user when pi is idle", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const ctx = mockContext();

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
  });

  it("steers message and reacts when pi is busy", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true; // simulate busy
    const piCommands = fakePi(gateway);

    const ctx = mockContext({ msg: { text: "second msg" } });
    const reactions: string[] = [];
    ctx.react = async (emoji: string) => { reactions.push(emoji); };

    await gateway.handleTextMessage(ctx, api);

    expect(piCommands).toEqual([{
      type: "steer",
      message: "second msg",
    }]);
    expect(reactions).toEqual(["👀"]);
  });

  it("passes unknown slash commands to Pi as prompts", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const ctx = mockContext({ msg: { text: "/skill:test" } });

    await gateway.handleTextMessage(ctx, api);

    expect(gateway.piStreaming).toBe(true);
  });
});

describe("Gateway.steerPi", () => {
  function steerGateway() {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    const piCommands = fakePi(gateway);
    return { gateway, piCommands };
  }

  it("sends steer RPC with message", () => {
    const { gateway, piCommands } = steerGateway();

    gateway.steerPi(123, "steered text");

    expect(piCommands).toEqual([{
      type: "steer",
      message: "steered text",
    }]);
  });

  it("includes images in the steer RPC when present", () => {
    const { gateway, piCommands } = steerGateway();

    gateway.steerPi(123, "look", undefined, [
      { type: "image", data: "aa==", mimeType: "image/png" },
    ]);

    expect(piCommands[0]).toEqual({
      type: "steer",
      message: "look",
      images: [{ type: "image", data: "aa==", mimeType: "image/png" }],
    });
  });

  it("takes no further action on disposition=queued", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "steer" ? { data: { disposition: "queued" } } : undefined);
    gateway.piStreaming = true;

    await gateway.steerPi(123, "steered text");

    expect(piCommands.length).toBe(1);
    expect(gateway.piStreaming).toBe(true); // run continues, pi delivers the steer
  });

  it("falls back to a fresh prompt run on disposition=handled", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    // Input handler consumed the steer without starting work
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "steer" ? { data: { disposition: "handled" } } : undefined);

    await gateway.steerPi(123, "steered text");

    expect(piCommands.length).toBe(2);
    expect(piCommands[1]).toEqual({ type: "prompt", message: "steered text" });
    expect(gateway.piStreaming).toBe(true);
  });

  it("falls back to a fresh prompt run on failed steer response", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    // e.g. message raced with agent_settled and pi already settled
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "steer" ? { success: false, error: "not streaming" } : undefined);
    gateway.piStreaming = true;

    await gateway.steerPi(123, "steered text");

    expect(piCommands.length).toBe(2);
    expect(piCommands[1]).toEqual({ type: "prompt", message: "steered text" });
  });

  it("keeps the current run streaming when the prompt fallback is handled", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    // pi refuses to queue extension commands; run via prompt they are handled at once
    const piCommands = fakePi(gateway, (cmd) =>
      cmd.type === "steer" ? { success: false, error: "Extension command \"/ext\" cannot be queued." }
      : cmd.type === "prompt" ? { data: { disposition: "handled" } } : undefined);
    gateway.piStreaming = true;
    gateway.currentChatId = 123;

    await gateway.steerPi(123, "/ext");

    expect(piCommands.map((c) => c.type)).toEqual(["steer", "prompt"]);
    expect(gateway.piStreaming).toBe(true); // the run's agent_settled will clear it
    expect(gateway.currentChatId).toBe(123);
  });
});

describe("Gateway.startPiSession prompt disposition", () => {
  it("stays streaming when pi starts a run", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    fakePi(gateway, () => ({ data: { disposition: "started" } }));

    await gateway.startPiSession(123, "hello");

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.currentChatId).toBe(123);
  });

  it("goes idle when an extension command handled the prompt (no agent_settled follows)", async () => {
    const sent: string[] = [];
    const gateway = newGateway({
      allowedUserId: 1,
      api: { ...mockApi(), sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; } },
    });
    fakePi(gateway, () => ({ data: { disposition: "handled" } }));

    await gateway.startPiSession(123, "/undo");

    expect(gateway.piStreaming).toBe(false);
    expect(gateway.currentChatId).toBe(0);
    expect(sent).toEqual([]);
  });

  it("leaves a running run's state alone when called while busy and no new run starts", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    fakePi(gateway, () => ({ data: { disposition: "handled" } }));
    gateway.piStreaming = true;
    gateway.currentChatId = 123;
    gateway.currentPlaceholderMessageId = 55;
    gateway.toolMessages.set("call1", { msgId: 56, startText: "🔧 bash" });

    await gateway.startPiSession(123, "/ext");

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.currentChatId).toBe(123);
    expect(gateway.currentPlaceholderMessageId).toBe(55);
    expect(gateway.toolMessages.size).toBe(1);
  });

  it("goes idle and reports the error when pi rejects the prompt", async () => {
    const sent: string[] = [];
    const gateway = newGateway({
      allowedUserId: 1,
      api: { ...mockApi(), sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; } },
    });
    fakePi(gateway, () => ({ success: false, error: "No API key" }));

    await gateway.startPiSession(123, "hello");

    expect(gateway.piStreaming).toBe(false);
    expect(sent).toEqual(["❌ No API key"]);
  });

  it("reports 'pi not connected' when there is no pi client", async () => {
    const sent: string[] = [];
    const gateway = new Gateway({
      allowedUserId: 1,
      api: { ...mockApi(), sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; } },
    });

    await gateway.startPiSession(123, "hello");

    expect(gateway.piStreaming).toBe(false);
    expect(sent).toEqual(["❌ pi not connected"]);
  });
});

describe("Gateway.sendTyping", () => {
  it("sends sendChatAction with 'typing'", () => {
    const actions: [number | string, string][] = [];
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async (chatId, action) => { actions.push([chatId, action]); },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.sendTyping(123);

    expect(actions).toEqual([[123, "typing"]]);
  });

  it("respects 4s cooldown on back-to-back calls", () => {
    let count = 0;
    const api: TelegramApi = {
      ...mockApi(),
      sendChatAction: async () => { count++; },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.sendTyping(123);
    expect(actions).toEqual(["typing"]);

    gateway.lastTypingSent = Date.now() - 5000;
    gateway.sendTyping(123);
    expect(actions).toEqual(["typing", "typing"]);
  });
});

describe("Gateway.handlePiEvent", () => {
  describe("extension_ui_request", () => {
    // Raw pi JSON, typed as handlePiEvent's (narrower) PiEvent
    const uiEvent = (e: Record<string, unknown>) => e as unknown as Parameters<Gateway["handlePiEvent"]>[0];

    function notifyGateway() {
      const sent: { chatId: number | string; text: string }[] = [];
      const gateway = newGateway({
        allowedUserId: 1,
        api: { ...mockApi(), sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 }; } },
      });
      return { gateway, sent };
    }

    it("forwards notify to the current chat with an icon per notifyType", async () => {
      const { gateway, sent } = notifyGateway();
      gateway.currentChatId = 123;

      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u1", method: "notify", message: "plain" }));
      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u2", method: "notify", message: "careful", notifyType: "warning" }));
      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u3", method: "notify", message: "broke", notifyType: "error" }));

      expect(sent).toEqual([
        { chatId: 123, text: "ℹ️ plain" },
        { chatId: 123, text: "⚠️ careful" },
        { chatId: 123, text: "❌ broke" },
      ]);
    });

    it("forwards notify to the allowed user when no chat is active", async () => {
      const { gateway, sent } = notifyGateway();

      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u1", method: "notify", message: "hi" }));

      expect(sent).toEqual([{ chatId: 1, text: "ℹ️ hi" }]);
    });

    it("ignores other extension UI methods", async () => {
      const { gateway, sent } = notifyGateway();
      gateway.currentChatId = 123;

      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u1", method: "setStatus", statusKey: "k", statusText: "x" }));
      await gateway.handlePiEvent(uiEvent({ type: "extension_ui_request", id: "u2", method: "select", title: "Pick", options: ["a"] }));

      expect(sent).toEqual([]);
    });
  });

  it("streams text_delta through relay", async () => {
    const api = mockApi();
    const edits: string[] = [];
    const gateway = newGateway({
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

  it("keeps piStreaming true across agent_end; agent_settled resets idle state", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });

    // Start a session
    await gateway.startPiSession(123, "first");
    expect(gateway.piStreaming).toBe(true);
    gateway.currentPlaceholderMessageId = 55;

    // agent_end closes only one low-level agent run — retries/steering may continue
    await gateway.handlePiEvent({ type: "agent_end" });
    expect(gateway.piStreaming).toBe(true);
    expect(gateway.currentChatId).toBe(123);

    // agent_settled is the true idle signal
    await gateway.handlePiEvent({ type: "agent_settled" });
    expect(gateway.piStreaming).toBe(false);
    expect(gateway.currentChatId).toBe(0);
    expect(gateway.currentPlaceholderMessageId).toBe(0);
  });

  it("sends tool summary on agent_end with tool counts", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 100 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0; // ignore placeholder message

    gateway.handlePiEvent({ type: "turn_start" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "read" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "write" });
    gateway.handlePiEvent({ type: "turn_end" });
    await gateway.handlePiEvent({ type: "agent_end" });

    const summary = sent.find(s => s.includes("tools used"));
    expect(summary).toBe("\uD83D\uDD27 5 tools used: bash \u00d73, read, write");
  });

  it("sends no tool summary when no tools were called", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 100 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
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

    const summary = sent.find(s => s.includes("tools used"));
    expect(summary).toBe("\uD83D\uDD27 4 tools used: bash \u00d72, grep, read");
  });

  it("clears tool counts after agent_end sends summary", async () => {
    const gateway = newGateway({
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
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(gateway.turnToolCounts.size).toBe(1);

    gateway.resetSession("test");
    expect(gateway.turnToolCounts.size).toBe(0);
  });

  it("tool_execution_start sends per-tool status message", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1" });

    expect(sent).toEqual(["🔧 <code>bash</code>..."]);
    expect(gateway.toolMessages.get("call_1")!.msgId).toBe(200);
  });

  it("tool_execution_start shows path preview for write/read/edit", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "write", toolCallId: "call_1", args: { path: "/home/user/src/config.yaml" } });
    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "edit", toolCallId: "call_2", args: { path: "/home/user/app.ts" } });

    expect(sent).toEqual([
      "🔧 <code>write</code> /home/user/src/config.yaml",
      "🔧 <code>edit</code> /home/user/app.ts",
    ]);
  });

  it("tool_execution_start left-trims long paths, right-trims long bash", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "call_1", args: { path: "/home/user/really/deeply/nested/project/src/config.yaml" } });
    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_2", args: { command: "python3 -c \"import sys; import json; import os; import pathlib; data = json.loads(open('/tmp/conf.json').read()); print(data)\"" } });

    expect(sent[0]).toBe("🔧 <code>read</code> …user/really/deeply/nested/project/src/config.yaml");
    expect(sent[1]!.startsWith("🔧 <code>bash</code> python3 -c \"import sys; import json; import os; import path")).toBe(true);
    expect(sent[1]!.length).toBeLessThanOrEqual(85);
  });

  it("tool_execution_start shows first line only for multiline bash", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: { command: "cd /tmp\nls -la\nrm -f *.log" } });

    expect(sent).toEqual(["🔧 <code>bash</code> cd /tmp"]);
  });

  it("tool_execution_start shows first non-comment line for codemode", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "codemode", toolCallId: "call_1", args: { code: "//!timeout_ms=5000\n// fetch and sort\nconst files = await tools.read({ path: '/tmp/a' })" } });

    expect(sent).toEqual(["🔧 <code>codemode</code> const files = await tools.read({ path: '/tmp/a' })"]);
  });

  it("tool_execution_start falls back for unknown tools", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 200 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");
    sent.length = 0;

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "grep", toolCallId: "call_1" });

    expect(sent).toEqual(["🔧 <code>grep</code>..."]);
  });

  it("tool_execution_end edits the status message", async () => {
    const edits: { msgId: number; text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 300 }),
      editMessageText: async (_c, msgId, text) => {
        edits.push({ msgId, text });
        return {};
      },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1" });
    await gateway.handlePiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "call_1" });

    expect(edits.length).toBe(1);
    expect(edits[0]!.msgId).toBe(300);
    expect(edits[0]!.text).toBe("✅ <code>bash</code>...");
  });

  it("parallel tools get independent status messages", async () => {
    const sent: string[] = [];
    const edits: { msgId: number; text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => {
        sent.push(text);
        return { message_id: sent.length + 400 };
      },
      editMessageText: async (_c, msgId, text) => {
        edits.push({ msgId, text });
        return {};
      },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1" });
    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "call_2" });

    expect(sent).toEqual(["🔧 <code>bash</code>...", "🔧 <code>read</code>..."]);
    expect(gateway.toolMessages.get("call_1")!.msgId).toBe(401);
    expect(gateway.toolMessages.get("call_2")!.msgId).toBe(402);

    await gateway.handlePiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "call_1" });
    await gateway.handlePiEvent({ type: "tool_execution_end", toolName: "read", toolCallId: "call_2" });

    expect(edits.length).toBe(2);
    expect(edits[0]!.msgId).toBe(401);
    expect(edits[0]!.text).toBe("✅ <code>bash</code>...");
    expect(edits[1]!.msgId).toBe(402);
    expect(edits[1]!.text).toBe("✅ <code>read</code>...");
  });

  it("tool_execution_start does nothing when currentChatId is 0", async () => {
    const sent: string[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { sent.push(text); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    // no startPiSession — currentChatId stays 0

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1" });

    expect(sent.length).toBe(0);
    expect(gateway.toolMessages.size).toBe(0);
  });

  it("tool_execution_end is no-op when toolCallId not in map", async () => {
    const edits: string[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async (_c, _m, text) => { edits.push(text); return {}; },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    await gateway.handlePiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "nonexistent" });

    expect(edits.length).toBe(0);
  });

  it("resetSession clears toolMessages", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });
    await gateway.startPiSession(123, "test");

    await gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1" });
    expect(gateway.toolMessages.size).toBe(1);

    gateway.resetSession("test");
    expect(gateway.toolMessages.size).toBe(0);
  });

  it("tool_execution_start still counts when currentChatId is 0", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });
    // no startPiSession → currentChatId = 0, no message sent

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(gateway.turnToolCounts.get("bash")).toBe(1);
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
    const gateway = newGateway({ allowedUserId: 1, api });
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
    // Error still surfaces at agent_end; idle only at agent_settled
    expect(gateway.piStreaming).toBe(true);
    await gateway.handlePiEvent({ type: "agent_settled" });
    expect(gateway.piStreaming).toBe(false);
  });

  it("bubbles Pi errors via sendMessage when no placeholder was ever created", async () => {
    const sent: { chatId: number | string; text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 77 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
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
    // Error still surfaces at agent_end; idle only at agent_settled
    expect(gateway.piStreaming).toBe(true);
    await gateway.handlePiEvent({ type: "agent_settled" });
    expect(gateway.piStreaming).toBe(false);
  });

  it("triggers sendTyping on events that mean Pi is working", async () => {
    const typingCalls: number[] = [];
    const api: TelegramApi = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => ({}),
      sendChatAction: async (chatId) => { typingCalls.push(chatId as number); },
    };
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.currentChatId = 0;

    gateway.handlePiEvent({ type: "message_start" });

        expect(actions).toEqual([]);
  });

  it("counts tools in turnToolCounts", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });

    gateway.handlePiEvent({ type: "tool_execution_start", toolName: "bash" });

    expect(gateway.turnToolCounts.get("bash")).toBe(1);
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

    const gateway = newGateway({ allowedUserId: 1, api });
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

    // Fixture predates agent_settled (recorded on pi 0.80.x); send it to reach idle
    await gateway.handlePiEvent({ type: "agent_settled" });

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
  it("clears relay and streaming state", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    await gateway.startPiSession(123, "active");
    expect(gateway.currentRelay).toBeNull();

    gateway.resetSession("test");

    expect(gateway.piStreaming).toBe(false);
    expect(gateway.currentRelay).toBeNull();
  });

  it("clears currentSessionId", () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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

describe("Gateway.showCompact", () => {
  it("formats compact response as HTML <pre> with tokensBefore", async () => {
    const messages: { text: string; other?: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text, other) => { messages.push({ text, other }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(456, { tokensBefore: 150000 });

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("<pre>");
    expect(messages[0]!.text).toContain("🗜️ Compacted");
    expect(messages[0]!.text).toContain("📥 Context before: 150.0K tokens");
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
  });

  it("formats tokensBefore with M suffix for large counts", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(1, { tokensBefore: 2_500_000 });

    expect(messages[0]!.text).toContain("2.5M tokens");
  });

  it("shows estimatedTokensAfter line when present", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(1, { tokensBefore: 150_000, estimatedTokensAfter: 32_000 });

    expect(messages[0]!.text).toContain("📥 Context before: 150.0K tokens");
    expect(messages[0]!.text).toContain("🔄 Context after: ~32.0K tokens (est.)");
  });

  it("formats estimatedTokensAfter with M suffix for large counts", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(1, { estimatedTokensAfter: 1_200_000 });

    expect(messages[0]!.text).toContain("🔄 Context after: ~1.2M tokens (est.)");
  });

  it("omits tokensBefore line when not present in data", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(1, {});

    expect(messages[0]!.text).toBe("<pre>🗜️ Compacted</pre>");
  });

  it("omits tokensBefore line when data is undefined", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showCompact(1, undefined);

    expect(messages[0]!.text).toBe("<pre>🗜️ Compacted</pre>");
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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    expect(messages[0]!.text).toContain("Session:");
    expect(messages[0]!.text).toContain("Cached sessions:");
  });

  it("shows running Pi with pid when piClient is connected", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.piClient = { pid: 12345, request: async () => ({ type: "response", success: true }), close: () => {} };

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
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.piStreaming = true;

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("busy");
  });

  it("shows queue-free status when messages arrive", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).not.toContain("Queue depth");
  });

  it("shows session ID short form when currentSessionId is set", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.currentSessionId = "01999999-aaaa-bbbb-cccc-ddddeeeeffff";

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("Session:");
    expect(messages[0]!.text).toContain("dddeeeeffff");
  });

  it("shows 'none' when no currentSessionId", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("Session:      none");
  });

  it("shows cached sessions count from sessionPicker.size", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    gateway.sessionPicker.set("a", { path: "/a.jsonl", id: "a", created: "2026-01-01T00:00:00.000Z", mtime: 1 });
    gateway.sessionPicker.set("b", { path: "/b.jsonl", id: "b", created: "2026-01-01T00:00:00.000Z", mtime: 2 });
    gateway.sessionPicker.set("c", { path: "/c.jsonl", id: "c", created: "2026-01-01T00:00:00.000Z", mtime: 3 });

    await gateway.showDaemonStatus(1);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("Cached sessions:");
    expect(messages[0]!.text).toContain("Cached sessions: 3");
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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

    await gateway.showLastMessage(1, undefined);

    expect(messages.length).toBe(0);
  });

  it("splits long text across multiple messages", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    const longText = "x".repeat(4100);
    await gateway.showLastMessage(1, { text: longText });

    expect(messages.length).toBe(2);
    expect(messages[0]!.text.length).toBeLessThanOrEqual(4000);
    expect(messages[1]!.text.length).toBeLessThanOrEqual(4000);
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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api }); // case-insensitive

    const data = {
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" },
      ],
    };

    await gateway.showModels(456, data, "claUde");

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(456);
    expect(messages[0]!.text).toContain('"claude"');
    const ik = (messages[0] as any).other?.reply_markup?.inline_keyboard;
    expect(ik).toBeDefined();
    expect(ik.length).toBe(1);
    expect(ik[0][0].text).toBe("anthropic/claude-sonnet-4-20250514");
    expect(ik[0][0].callback_data).toBe("model:anthropic/claude-sonnet-4-20250514");
  });

  it("filters by model id as well as name", async () => {
    const messages: any[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, _t, other) => { messages.push(other); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    const data = {
      models: [
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      ],
    };

    await gateway.showModels(1, data, "minimax");

    const ik = (messages[0] as any)?.reply_markup?.inline_keyboard;
    expect(ik).toBeDefined();
    expect(ik.length).toBe(1);
    expect(ik[0][0].text).toBe("opencode-go/minimax-m2.5");
  });

  it("filters by provider/id combined string", async () => {
    const messages: any[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, _t, other) => { messages.push(other); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

    const data = {
      models: [
        { provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { provider: "opencode-go", id: "gemma-3", name: "Gemma 3" },
      ],
    };

    await gateway.showModels(1, data, "opencode-go/minimax");

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
    const gateway = newGateway({ allowedUserId: 1, api });

    const data = { models: [{ provider: "x", id: "y", name: "Test" }] };

    await gateway.showModels(1, data, "nonexistent");

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe('No models matching "nonexistent".');
  });

  it("shows empty message when no models available", async () => {
    const messages: { text: string }[] = [];
    const api: TelegramApi = {
      sendMessage: async (_c, text) => { messages.push({ text }); return { message_id: 1 }; },
      editMessageText: async () => ({}),
    };
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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
    const gateway = newGateway({ allowedUserId: 1, api });

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

// Slash command handlers: each awaits requestPi() and replies to its chatId
function sentTo(): { api: TelegramApi; messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] } {
  const messages: { chatId: number | string; text: string; other?: Record<string, unknown> }[] = [];
  const api: TelegramApi = {
    ...mockApi(),
    sendMessage: async (chatId, text, other) => { messages.push({ chatId, text, other }); return { message_id: 1 }; },
  };
  return { api, messages };
}

// Fixture lines are recorded pi responses; replay one as requestPi's answer
function fixtureResponse(name: string): Partial<PiResponse> {
  return JSON.parse(loadFixtureLines(name)[0]!) as PiResponse;
}

describe("Gateway slash commands", () => {
  it("cmdState stores currentSessionId and shows status to the given chat", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, () => ({ data: { sessionId: "sid-1", model: { provider: "p", id: "m" } } }));

    await gateway.cmdState(789);

    expect(piCommands).toEqual([{ type: "get_state" }]);
    expect(gateway.currentSessionId).toBe("sid-1");
    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(789);
    expect(messages[0]!.text).toContain("sid-1");
  });

  it("cmdState keeps currentSessionId when get_state has no sessionId", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    fakePi(gateway, () => ({ data: {} }));
    gateway.currentSessionId = "old";

    await gateway.cmdState(1);

    expect(gateway.currentSessionId).toBe("old");
  });

  it("cmdState reports a failed get_state", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({ success: false, error: "boom" }));

    await gateway.cmdState(1);

    expect(messages.map((m) => m.text)).toEqual(["❌ Status failed: boom"]);
  });

  it("replays get-state.jsonl through cmdState", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => fixtureResponse("get-state.jsonl"));

    await gateway.cmdState(123);

    expect(messages.length).toBe(1);
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(messages[0]!.text).toContain("opencode-go/minimax-m2.5");
    expect(messages[0]!.text).toContain("019e23a4-4c58-71a1-b3b9-6da3b6c97a28");
    expect(messages[0]!.text).toContain("medium");
  });

  it("cmdSession shows status then stats (replayed fixtures)", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, (cmd) =>
      fixtureResponse(cmd.type === "get_state" ? "get-state.jsonl" : "get-session-stats.jsonl"));

    await gateway.cmdSession(123);

    expect(piCommands.map((c) => c.type).sort()).toEqual(["get_session_stats", "get_state"]);
    expect(messages.length).toBe(2);
    expect(messages[0]!.text).toContain("🤖 Model:");
    expect(messages[1]!.text).toContain("$0.0000");
    expect(messages[1]!.text).toContain("📁 Session file:");
  });

  it("cmdLast replays get-last-assistant-text.jsonl", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => fixtureResponse("get-last-assistant-text.jsonl"));

    await gateway.cmdLast(123);

    expect(messages.length).toBe(1);
    expect(messages[0]!.other).toEqual({ parse_mode: "MarkdownV2" });
    expect(messages[0]!.text).toContain("Got it, just testing the waters\\.");
  });

  it("cmdNew resets, sends new_session, confirms, then shows status", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "get_state" ? { data: { sessionId: "new-sid" } } : undefined);
    gateway.currentSessionId = "old-sid";
    gateway.piStreaming = true;

    await gateway.cmdNew(5);

    expect(piCommands).toEqual([{ type: "new_session" }, { type: "get_state" }]);
    expect(gateway.piStreaming).toBe(false);
    expect(gateway.currentSessionId).toBe("new-sid");
    expect(messages[0]!.text).toBe("🆕 New session. Ready to roll 🫡");
    expect(messages[1]!.text).toContain("new-sid");
  });

  it("cmdNew reports a failed new_session and skips get_state", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, () => ({ success: false, error: "nope" }));

    await gateway.cmdNew(5);

    expect(piCommands).toEqual([{ type: "new_session" }]);
    expect(messages.map((m) => m.text)).toEqual(["❌ New session failed: nope"]);
  });

  it("cmdDelete unlinks the current session file, then starts a new session", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "get_state" ? { data: { sessionId: "new-sid" } } : undefined);
    const deleted: string[] = [];
    gateway.deleteFile = async (path) => { deleted.push(path); };
    gateway.currentSessionId = "old-sid";
    gateway.sessionPicker.set("old-sid", { path: "/tmp/old.jsonl", id: "old-sid", created: "2026-01-01T00:00:00.000Z", mtime: 1 });

    await gateway.cmdDelete(5);

    expect(deleted).toEqual(["/tmp/old.jsonl"]);
    expect(piCommands).toEqual([{ type: "new_session" }, { type: "get_state" }]);
    expect(gateway.currentSessionId).toBe("new-sid");
    expect(messages[0]!.text).toBe("🗑️ Session deleted. New session: standing by 🫡");
  });

  it("cmdName confirms only after pi accepts", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);
    await gateway.cmdName(5, "evil plan");
    expect(piCommands).toEqual([{ type: "set_session_name", name: "evil plan" }]);

    fakePi(gateway, () => ({ success: false, error: "Session name cannot be empty" }));
    await gateway.cmdName(5, " ");

    expect(messages.map((m) => m.text)).toEqual(["✏️ Named.", "❌ Naming failed: Session name cannot be empty"]);
  });

  it("cmdModels passes the filter to showModels", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({
      data: { models: [{ provider: "opencode-go", id: "minimax-m2.5", name: "MiniMax M2.5" }, { provider: "x", id: "y", name: "Y" }] },
    }));

    await gateway.cmdModels(5, "minimax");

    expect(messages.length).toBe(1);
    const ik = (messages[0]!.other as any)?.reply_markup?.inline_keyboard;
    expect(ik.length).toBe(1);
    expect(ik[0][0].callback_data).toBe("model:opencode-go/minimax-m2.5");
  });

  it("setModel returns the picker text for success and failure", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    const piCommands = fakePi(gateway);
    expect(await gateway.setModel("p", "m")).toBe("✅ Model: p/m");
    expect(piCommands).toEqual([{ type: "set_model", provider: "p", modelId: "m" }]);

    fakePi(gateway, () => ({ success: false, error: "Model not found: p/m" }));
    expect(await gateway.setModel("p", "m")).toBe("❌ Model switch failed: Model not found: p/m");
  });

  it("cmdThinkingLevels renders the list with an inline keyboard", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({ data: { levels: ["off", "low", "high"] } }));

    await gateway.cmdThinkingLevels(123);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(123);
    expect(messages[0]!.text).toContain("💭 Available thinking levels (3)");
    expect(messages[0]!.text).toContain("off\nlow\nhigh");
    const kb = (messages[0]!.other as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }).reply_markup.inline_keyboard;
    expect(kb[0]!.map((b) => b.callback_data)).toEqual(["think:off", "think:low", "think:high"]);
  });

  it("cmdThinkingLevels shows a friendly message when none are available", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({ data: { levels: [] } }));

    await gateway.cmdThinkingLevels(123);

    expect(messages.map((m) => m.text)).toEqual(["❌ No thinking levels available."]);
  });

  it("cmdSetThinkingLevel acks with the requested level, or the error", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);
    await gateway.cmdSetThinkingLevel(123, "high");
    expect(piCommands).toEqual([{ type: "set_thinking_level", level: "high" }]);

    fakePi(gateway, () => ({ success: false, error: "invalid level" }));
    await gateway.cmdSetThinkingLevel(123, "bogus");

    expect(messages.map((m) => m.text)).toEqual(["💭 Thinking level: high", "❌ Thinking level failed: invalid level"]);
  });

  it("cmdCompact sends customInstructions and shows the result", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, () => ({ data: { tokensBefore: 12000, estimatedTokensAfter: 3000 } }));

    await gateway.cmdCompact(5, "keep the plan");

    expect(piCommands).toEqual([{ type: "compact", customInstructions: "keep the plan" }]);
    expect(messages[0]!.text).toContain("🗜️ Compacted");
    expect(messages[0]!.text).toContain("12.0K");
  });

  it("cmdCompact reports failure", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, () => ({ success: false, error: "Already compacted" }));

    await gateway.cmdCompact(5);

    expect(piCommands).toEqual([{ type: "compact" }]);
    expect(messages.map((m) => m.text)).toEqual(["❌ Compaction failed: Already compacted"]);
  });

  it("cmdAbortBash sends abort_bash and confirms", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);

    await gateway.cmdAbortBash(5);

    expect(piCommands).toEqual([{ type: "abort_bash" }]);
    expect(messages.map((m) => m.text)).toEqual(["🛑 Bash aborted."]);
  });

  it("runBash sends output as <pre> chunks to the given chat", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({ data: { output: "hi <b>\n", exitCode: 0 } }));

    await gateway.runBash(789, "echo hi", false);

    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(789);
    expect(messages[0]!.text).toBe("<pre>Exit code: 0\n\nhi &lt;b&gt;\n</pre>");
    expect(messages[0]!.other).toEqual({ parse_mode: "HTML" });
  });

  it("runBash reports a failed bash command", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    fakePi(gateway, () => ({ success: false, error: "pi exited (code=1)" }));

    await gateway.runBash(789, "echo hi", true);

    expect(messages.map((m) => m.text)).toEqual(["❌ Bash failed: pi exited (code=1)"]);
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
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const sessions = gateway.scanRecentSessions(10, sessionsDir);

    // 5 files total, but bogus.jsonl has no session header → only 4 returned
    expect(sessions.length).toBe(4);
  });

  it("recurses into subdirectories", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });
    const sessionsDir = setupSessionFixtures();

    const sessions = gateway.scanRecentSessions(10, sessionsDir);

    const subdirSession = sessions.find(s => s.id === "01999999-4444-7aaa-bbbb-ccccddddhhhh");
    expect(subdirSession).not.toBeUndefined();
    expect(subdirSession!.path).toContain("subdir/");
  });

  it("populates sessionPicker map", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });
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
    const gateway = newGateway({ allowedUserId: 1, api });
    const emptyDir = mkdtempSync(join(tmpdir(), "kklaw-test-empty-"));

    const sessions = gateway.scanRecentSessions(10, emptyDir);

    expect(sessions.length).toBe(0);
    expect(gateway.sessionPicker.size).toBe(0);
  });

  it("handles nonexistent directory", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 1, api });

    const sessions = gateway.scanRecentSessions(10, "/nonexistent/path/xyz");

    expect(sessions.length).toBe(0);
    expect(gateway.sessionPicker.size).toBe(0);
  });
});

// ============================================================
// Session switching tests
// ============================================================

describe("Gateway.switchToSession", () => {
  it("sends switch_session, then shows the new session status", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, (cmd) => cmd.type === "get_state" ? { data: { sessionId: "01999999-2222-7aaa-bbbb-ccccddddffff" } } : undefined);
    const sessionsDir = setupSessionFixtures();
    gateway.scanRecentSessions(10, sessionsDir);
    gateway.currentSessionId = "old-sid";

    await gateway.switchToSession(789, "01999999-2222-7aaa-bbbb-ccccddddffff");

    expect(piCommands).toEqual([
      { type: "switch_session", sessionPath: expect.stringContaining("01999999-2222-7aaa-bbbb-ccccddddffff.jsonl") },
      { type: "get_state" },
    ]);
    expect(gateway.currentSessionId).toBe("01999999-2222-7aaa-bbbb-ccccddddffff");
    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(789);
  });

  it("reports a failed switch_session and skips get_state", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, () => ({ success: false, error: "file gone" }));
    gateway.scanRecentSessions(10, setupSessionFixtures());

    await gateway.switchToSession(789, "01999999-2222-7aaa-bbbb-ccccddddffff");

    expect(piCommands.length).toBe(1);
    expect(messages.map((m) => m.text)).toEqual(["❌ Switch failed: file gone"]);
  });

  it("does nothing when session is not in picker", async () => {
    const gateway = newGateway({ allowedUserId: 1, api: mockApi() });
    const piCommands = fakePi(gateway);

    await gateway.switchToSession(789, "nonexistent-id");

    expect(piCommands.length).toBe(0);
  });
});

// ============================================================
// Integration: session switch then /last
// ============================================================

describe("Integration: /resume then /last", () => {
  it("switches session and then /last returns correct text", async () => {
    const { api, messages } = sentTo();
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway, (cmd) =>
      cmd.type === "get_last_assistant_text" ? { data: { text: "The auth bug is fixed." } } : undefined);
    gateway.scanRecentSessions(10, setupSessionFixtures());

    await gateway.switchToSession(789, "01999999-1111-7aaa-bbbb-ccccddddeeee");
    messages.length = 0; // drop the status message
    await gateway.cmdLast(789);

    expect(piCommands.map((c) => c.type)).toEqual(["switch_session", "get_state", "get_last_assistant_text"]);
    expect(messages.length).toBe(1);
    expect(messages[0]!.chatId).toBe(789);
    expect(messages[0]!.text).toBe("The auth bug is fixed\\.");
  });
});

describe("Gateway.handlePhotoMessage", () => {
  it("rejects unauthorized user", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 999, api });
    gateway.downloadFile = async () => Buffer.from("fake");
    const ctx = mockPhotoContext({ from: { id: 111 } });
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handlePhotoMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("starts a session with caption and image when pi is idle", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("test");
    const piCommands = fakePi(gateway);

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
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("img");
    const piCommands = fakePi(gateway);

    const ctx = mockPhotoContext({ msg: { caption: undefined, photo: mockPhotoContext().msg.photo } });
    await gateway.handlePhotoMessage(ctx, api);

    expect(piCommands[0]).toHaveProperty("message", "");
    expect(piCommands[0]).toHaveProperty("images");
  });

  it("picks the largest photo by file_size", async () => {
    const downloadedIds: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async (fileId) => { downloadedIds.push(fileId); return Buffer.from("img"); };

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
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => { throw new Error("network down"); };

    const ctx = mockPhotoContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(replies).toEqual(["Failed to download photo."]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("steers message with images when pi is busy", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.downloadFile = async () => Buffer.from("busy-img");
    const piCommands = fakePi(gateway);
    const reactions: string[] = [];
    const ctx = mockPhotoContext();
    ctx.react = async (emoji) => { reactions.push(emoji); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(piCommands).toEqual([{
      type: "steer",
      message: "what's in this photo",
      images: [{
        type: "image",
        data: Buffer.from("busy-img").toString("base64"),
        mimeType: "image/jpeg",
      }],
    }]);
    expect(reactions).toEqual(["👀"]);
  });

  it("replies with saved filename after photo download", async () => {
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("photo-data");
    const piCommands = fakePi(gateway);
    gateway.saveUpload = async () => "/uploads/1747380800000.jpeg";

    const ctx = mockPhotoContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(replies).toEqual(["📎 Saved: <code>/uploads/1747380800000.jpeg</code> — Sending to Pi…"]);
    expect(piCommands.length).toBe(1);
  });

  it("replies 'Not saved' when UPLOAD_DIR is not set (saveUpload returns null)", async () => {
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("photo-data");
    gateway.saveUpload = async () => null;

    const ctx = mockPhotoContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handlePhotoMessage(ctx, api);

    expect(replies).toEqual(["📤 Not saved (UPLOAD_DIR not set), directly sending to Pi…"]);
    expect(gateway.piStreaming).toBe(true);
  });

  it("startPiSession includes images in RPC command", async () => {
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 11 }),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);

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
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 12 }),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);

    await gateway.startPiSession(123, "hello", api, []);

    expect(piCommands).toEqual([{
      type: "prompt",
      message: "hello",
    }]);
  });

  it("startPiSession omits images when undefined", async () => {
    const api: TelegramApi = {
      ...mockApi(),
      sendMessage: async () => ({ message_id: 13 }),
    };
    const gateway = newGateway({ allowedUserId: 1, api });
    const piCommands = fakePi(gateway);

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
    const gateway = newGateway({ allowedUserId: 999, api });
    gateway.downloadFile = async () => Buffer.from("fake");
    const ctx = mockDocumentContext({ from: { id: 111 } });
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("ignores document with missing file_id", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });

    const ctx = mockDocumentContext({ msg: { document: undefined } });
    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
  });

  it("replies with error when UPLOAD_DIR is not set", async () => {
    delete process.env.UPLOAD_DIR;
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });

    const ctx = mockDocumentContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleDocumentMessage(ctx, api);

    expect(replies).toEqual(["❌ UPLOAD_DIR is not set. Cannot save document."]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("does NOT start Pi session (documents are never auto-passed)", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("doc-data");

    // Even with a valid document, UPLOAD_DIR is null → error reply, no Pi interaction
    const ctx = mockDocumentContext({
      msg: { document: { file_id: "f1", mime_type: "application/pdf", file_name: "doc.pdf" } },
    });

    await gateway.handleDocumentMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
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

describe("Gateway.injectPrompt", () => {
  it("starts a session when pi is idle", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    // pi idle, currentChatId is set
    gateway.currentChatId = 456;
    gateway.injectPrompt("injected prompt text", "test.txt");

    expect(gateway.piStreaming).toBe(true);
    expect(gateway.currentChatId).toBe(456);
    expect(piCommands).toEqual([{ type: "prompt", message: "injected prompt text" }]);
  });

  it("falls back to allowedUserId when currentChatId is 0", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    // currentChatId defaults to 0
    gateway.injectPrompt("prompt text", "test.txt");

    expect(gateway.currentChatId).toBe(8476228873);
    expect(piCommands).toEqual([{ type: "prompt", message: "prompt text" }]);
  });

  it("steers the message when pi is busy", () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    gateway.piStreaming = true;
    gateway.currentChatId = 789;

    gateway.injectPrompt("steered prompt", "test.txt");

    expect(piCommands).toEqual([{
      type: "steer",
      message: "steered prompt",
    }]);
  });
});

describe("Gateway.handleTextMessage (! commands)", () => {
  it("sends bash RPC for !command", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    const ctx = mockContext({ msg: { text: "!ls" } });
    await gateway.handleTextMessage(ctx, api);

    expect(piCommands).toEqual([{ type: "bash", command: "ls" }]);
    // Does NOT set piStreaming
    expect(gateway.piStreaming).toBe(false);
  });

  it("trims whitespace from !command", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    const ctx = mockContext({ msg: { text: "!  echo hello  " } });
    await gateway.handleTextMessage(ctx, api);

    expect(piCommands).toEqual([{ type: "bash", command: "echo hello" }]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("preserves full command string after ! prefix", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    const ctx = mockContext({ msg: { text: "!echo hello world with spaces" } });
    await gateway.handleTextMessage(ctx, api);

    expect(piCommands).toEqual([{ type: "bash", command: "echo hello world with spaces" }]);
  });

  it("replies with usage when ! has no command", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    const replies: Array<{ text: string; other?: Record<string, unknown> }> = [];
    const ctx = mockContext({
      msg: { text: "!" },
      reply: async (text: string, other?: Record<string, unknown>) => {
        replies.push({ text, other });
      },
    });

    await gateway.handleTextMessage(ctx, api);

    expect(replies.length).toBe(1);
    expect(replies[0]!.text).toContain("Usage");
    expect(replies[0]!.other).toEqual({ parse_mode: "HTML" });
    expect(piCommands.length).toBe(0);
  });

  it("replies with usage when ! is only whitespace", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    const piCommands = fakePi(gateway);

    const replies: Array<{ text: string }> = [];
    const ctx = mockContext({
      msg: { text: "!   " },
      reply: async (text: string) => {
        replies.push({ text });
      },
    });

    await gateway.handleTextMessage(ctx, api);

    expect(replies.length).toBe(1);
    expect(piCommands.length).toBe(0);
  });

  it("rejects !command from unauthorized user", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 999, api });
    const piCommands = fakePi(gateway);

    const ctx = mockContext({ from: { id: 111 }, msg: { text: "!rm -rf /" } });
    await gateway.handleTextMessage(ctx, api);

    // Unauthorized — no sendPi
    expect(piCommands.length).toBe(0);
  });

  it("!command bypasses busy path (always fires immediately)", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true; // simulate busy

    const piCommands = fakePi(gateway);

    const ctx = mockContext({ msg: { text: "!df -h" } });
    await gateway.handleTextMessage(ctx, api);

    // Bash commands bypass the steer path regardless of stream state
    expect(piCommands).toEqual([{ type: "bash", command: "df -h" }]);
  });
});

describe("Gateway.handleVoiceMessage", () => {
  it("rejects unauthorized user", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 999, api });
    gateway.downloadFile = async () => Buffer.from("fake");
    const ctx = mockVoiceContext({ from: { id: 111 } });
    let replied = false;
    ctx.reply = async () => { replied = true; };

    await gateway.handleVoiceMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
    expect(replied).toBe(false);
  });

  it("returns error when UPLOAD_DIR is not set", async () => {
    delete process.env.UPLOAD_DIR;
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("fake");

    const ctx = mockVoiceContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleVoiceMessage(ctx, api);

    expect(replies).toEqual(["❌ UPLOAD_DIR is not set. Cannot save voice message."]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("ignores voice message with missing file_id", async () => {
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });

    const ctx = mockVoiceContext({ msg: { voice: undefined } });
    await gateway.handleVoiceMessage(ctx, api);

    expect(gateway.piStreaming).toBe(false);
  });

  it("replies 'Failed to download voice message.' on download error", async () => {
    process.env.UPLOAD_DIR = "/uploads";
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => { throw new Error("network down"); };

    const ctx = mockVoiceContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleVoiceMessage(ctx, api);

    expect(replies).toEqual(["Failed to download voice message."]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("replies 'Failed to save voice message.' when saveUpload returns null", async () => {
    process.env.UPLOAD_DIR = "/uploads";
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("ogg-data");
    gateway.saveUpload = async () => null;

    const ctx = mockVoiceContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleVoiceMessage(ctx, api);

    expect(replies).toEqual(["Failed to save voice message."]);
    expect(gateway.piStreaming).toBe(false);
  });

  it("starts a session with voice prompt when pi is idle", async () => {
    process.env.UPLOAD_DIR = "/uploads";
    const replies: string[] = [];
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.downloadFile = async () => Buffer.from("ogg-data");
    const piCommands = fakePi(gateway);
    gateway.saveUpload = async () => "/uploads/voice_1234567890.ogg";

    const ctx = mockVoiceContext();
    ctx.reply = async (text) => { replies.push(text); };

    await gateway.handleVoiceMessage(ctx, api);

    expect(replies[0]).toContain("voice message from user: /uploads/voice_1234567890.ogg");
    expect(piCommands).toEqual([{
      type: "prompt",
      message: "voice message from user: /uploads/voice_1234567890.ogg",
    }]);
    expect(gateway.piStreaming).toBe(true);
  });

  it("steers voice prompt and reacts when pi is busy", async () => {
    process.env.UPLOAD_DIR = "/uploads";
    const api = mockApi();
    const gateway = newGateway({ allowedUserId: 8476228873, api });
    gateway.piStreaming = true;
    gateway.downloadFile = async () => Buffer.from("busy-ogg");
    gateway.saveUpload = async () => "/uploads/voice_busy.ogg";
    const piCommands = fakePi(gateway);

    const reactions: string[] = [];
    const ctx = mockVoiceContext();
    ctx.react = async (emoji) => { reactions.push(emoji); };

    await gateway.handleVoiceMessage(ctx, api);

    expect(piCommands).toEqual([{
      type: "steer",
      message: "voice message from user: /uploads/voice_busy.ogg",
    }]);
    expect(reactions).toEqual(["👀"]);
  });
});

describe("extFromMime", () => {
  it("extracts audio extensions", () => {
    expect(extFromMime("audio/ogg")).toBe(".ogg");
    expect(extFromMime("audio/mpeg")).toBe(".mpeg");
  });
});
