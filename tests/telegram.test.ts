import { describe, it, expect } from "bun:test";
import { createSafeEditor, splitTelegramText, isParseError, type TelegramApi } from "../telegram";

// --- isParseError -----------------------------------------------------------

describe("isParseError", () => {
  it("matches 'can't parse entities'", () => {
    expect(isParseError("can't parse entities: invalid char at offset")).toBe(true);
  });

  it("matches 'unsupported start tag'", () => {
    expect(isParseError('unsupported start tag "b" at byte offset 5')).toBe(true);
  });

  it("matches 'unexpected end tag'", () => {
    expect(isParseError("unexpected end tag")).toBe(true);
  });

  it("matches 'entity name expected'", () => {
    expect(isParseError("entity name expected")).toBe(true);
  });

  it("matches standalone 'parse entities'", () => {
    expect(isParseError("parse entities error")).toBe(true);
  });

  it("matches 'can't parse message text'", () => {
    expect(isParseError("can't parse message text: invalid formatting")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isParseError("CAN'T PARSE ENTITIES")).toBe(true);
    expect(isParseError("Unsupported Start Tag")).toBe(true);
    expect(isParseError("PARSE ENTITIES")).toBe(true);
    expect(isParseError("Can't Parse Message Text")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isParseError("MESSAGE_TOO_LONG")).toBe(false);
    expect(isParseError("message is not modified")).toBe(false);
    expect(isParseError("some random error")).toBe(false);
    expect(isParseError("")).toBe(false);
  });

  it("works with Error instances", () => {
    expect(isParseError(new Error("can't parse entities"))).toBe(true);
    expect(isParseError(new Error("MESSAGE_TOO_LONG"))).toBe(false);
    expect(isParseError(new Error("Generic error"))).toBe(false);
  });

  it("handles non-string, non-Error values", () => {
    expect(isParseError(undefined)).toBe(false);
    expect(isParseError(null)).toBe(false);
    expect(isParseError(123)).toBe(false);
    expect(isParseError({})).toBe(false);
  });
});

// --- splitTelegramText ------------------------------------------------------

describe("splitTelegramText", () => {
  it("returns single-element array for text shorter than maxLen", () => {
    expect(splitTelegramText("hello", 10)).toEqual(["hello"]);
    expect(splitTelegramText("hello world", 4000)).toEqual(["hello world"]);
  });

  it("returns [empty string] for empty input", () => {
    expect(splitTelegramText("")).toEqual([""]);
    expect(splitTelegramText("", 100)).toEqual([""]);
  });

  it("splits at newline when available near maxLen", () => {
    const text = "line1\nline2\nline3";
    const result = splitTelegramText(text, 6);
    expect(result).toEqual(["line1", "line2", "line3"]);
  });

  it("falls back to word boundary (space) when no newline near maxLen", () => {
    const text = "hello world foo bar";
    const result = splitTelegramText(text, 8);
    expect(result[0]).toBe("hello");
    expect(result[1]).toBe("world");
  });

  it("hard-cuts at maxLen when no newline or space within 50% of maxLen", () => {
    const text = "abcdefghij";
    const result = splitTelegramText(text, 5);
    expect(result).toEqual(["abcde", "fghij"]);
  });

  it("trims whitespace at chunk boundaries", () => {
    const text = "hello  \n  world";
    const result = splitTelegramText(text, 6);
    expect(result).toEqual(["hello", "world"]);
  });

  it("uses default maxLen of 4000 when not specified", () => {
    const text = "short";
    const result = splitTelegramText(text);
    expect(result).toEqual(["short"]);
  });

  it("handles multi-chunk text correctly", () => {
    // 9500 chars = 2 full 4000-char chunks + 1500 remainder
    const text = "A".repeat(9500);
    const result = splitTelegramText(text, 4000);
    expect(result.length).toBe(3);
    expect(result[0].length).toBe(4000);
    expect(result[1].length).toBe(4000);
    expect(result[2].length).toBe(1500);
  });

  it("does not produce empty chunks for whitespace-only boundaries", () => {
    const text = "hello\n\n\nworld";
    const result = splitTelegramText(text, 6);
    expect(result).toEqual(["hello", "world"]);
  });
});

// --- createSafeEditor --------------------------------------------------------

function stubApi(overrides?: Partial<TelegramApi>): TelegramApi {
  return {
    sendMessage: async () => ({ message_id: 42 }),
    editMessageText: async () => ({}),
    sendChatAction: async () => ({}),
    getFile: async () => ({ file_path: "test" }),
    ...overrides,
  };
}

describe("createSafeEditor", () => {
  it("edits with MarkdownV2 parse_mode by default", async () => {
    const edits: Array<{ text: string; parseMode?: string }> = [];
    const api = stubApi({
      editMessageText: async (_cid, _mid, text, other) => {
        edits.push({ text, parseMode: other?.parse_mode as string });
        return {};
      },
    });
    const editor = createSafeEditor(api, 123, 100);

    await editor.edit("Hello World");
    await editor.edit("Hello World\nMore text");

    expect(edits).toEqual([
      { text: "Hello World", parseMode: "MarkdownV2" },
      { text: "Hello World\nMore text", parseMode: "MarkdownV2" },
    ]);
  });

  it("swallows 'message is not modified' errors", async () => {
    const api = stubApi({
      editMessageText: async () => {
        throw new Error("400: message is not modified");
      },
    });
    const editor = createSafeEditor(api, 123, 100);

    // Should not throw
    await editor.edit("unchanged text");
  });

  it("handles MESSAGE_TOO_LONG with rollback and chunking", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: Array<{ text: string; parseMode?: string }> = [];
    const logCalls: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text, other) => {
        sentMessages.push({ text, parseMode: other?.parse_mode as string });
        return { message_id: ++nextMsgId };
      },
      editMessageText: async (_cid, mid, text, _other) => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    // First edit succeeds
    await editor.edit("Hello World");

    // Second edit: append long content that triggers MESSAGE_TOO_LONG
    const long = "A".repeat(5000);
    await editor.edit("Hello World" + long);

    // 3 editMessageText calls:
    //   1. "Hello World" (succeeds)
    //   2. "Hello World" + long (throws MESSAGE_TOO_LONG)
    //   3. Rollback "Hello World" (succeeds)
    expect(editCalls).toBe(3);

    // Chunks sent via sendMessage
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0]).toEqual(
      expect.objectContaining({ text: "A".repeat(4000), parseMode: "MarkdownV2" }),
    );
    expect(sentMessages[1]).toEqual(
      expect.objectContaining({ text: "A".repeat(1000), parseMode: "MarkdownV2" }),
    );
  });

  it("chunks the very first message if it is already too long (no rollback)", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async () => {
        editCalls++;
        throw new Error("400: MESSAGE_TOO_LONG");
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100);

    const longText = "A".repeat(6000);
    await editor.edit(longText);

    // No rollback attempted (goodText is "" which is falsy)
    // Chunks sent directly
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0]).toBe("A".repeat(4000));
    expect(sentMessages[1]).toBe("A".repeat(2000));
  });

  it("prepends '> ' to chunk when blockquote line continues past a MESSAGE_TOO_LONG split", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];
    const logCalls: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async (_cid, _mid, _text) => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    // Set up goodText ending with a blockquote line
    await editor.edit("intro\n> blockquote");

    // Next edit overflows; remainder does NOT start with '>'
    const overflow = "X".repeat(5000);
    await editor.edit("intro\n> blockquote" + overflow);

    expect(sentMessages.length).toBeGreaterThan(0);
    // First chunk should have '> ' prepended
    expect(sentMessages[0]).toStartWith("> X");
  });

  it("does not prepend '> ' when remainder already starts with '>'", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async (_cid, _mid, _text) => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100);

    await editor.edit("intro\n> blockquote");

    // Remainder starts with '>' already — no prepend needed
    const overflow = "> continued quote" + "X".repeat(5000);
    await editor.edit("intro\n> blockquote" + overflow);

    expect(sentMessages.length).toBeGreaterThan(0);
    // First chunk should not double-prepend '> '
    expect(sentMessages[0]).toStartWith("> continued quote");
  });

  it("skips parse errors during streaming (non-final) and logs a warning", async () => {
    const logCalls: string[] = [];
    const api = stubApi({
      editMessageText: async () => {
        throw new Error("400: can't parse entities");
      },
    });
    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    // Should not throw
    await editor.edit("some **text**", false);

    expect(logCalls.length).toBe(1);
    expect(logCalls[0]).toContain("parse error during streaming");
  });

  it("falls back to plain text on parse error when final", async () => {
    let callCount = 0;
    const edits: Array<{ text: string; parseMode?: string }> = [];
    const logCalls: string[] = [];

    const api = stubApi({
      editMessageText: async (_cid, _mid, text, other) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("400: can't parse entities");
        }
        edits.push({ text, parseMode: other?.parse_mode as string });
        return {};
      },
    });
    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("**broken** markdown", true); // isFinal = true

    // First call threw parse error → fallback plain-text edit
    expect(callCount).toBe(2);
    expect(edits).toEqual([{ text: "**broken** markdown", parseMode: undefined }]);
  });

  it("logs fallback failure when plain-text edit also fails on final parse error", async () => {
    let callCount = 0;
    const logCalls: string[] = [];

    const api = stubApi({
      editMessageText: async () => {
        callCount++;
        throw new Error(callCount === 1 ? "400: can't parse entities" : "400: bad request");
      },
    });
    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("**broken** **again**", true);

    expect(callCount).toBe(2);
    const fallbackLog = logCalls.find((l) => l.includes("plain fallback edit failed"));
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog).toContain("bad request");
  });

  it("logs generic non-parse, non-too-long, non-not-modified errors", async () => {
    const logCalls: string[] = [];
    const api = stubApi({
      editMessageText: async () => {
        throw new Error("500: Internal Server Error");
      },
    });
    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("some text");

    expect(logCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls[0]).toContain("edit failed");
    expect(logCalls[0]).toContain("Internal Server Error");
  });

  it("handles MESSAGE_TOO_LONG rollback failure gracefully and still sends chunks", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];
    const logCalls: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async (_cid, _mid, _text, _other) => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        if (editCalls === 3) {
          // Rollback also fails
          throw new Error("400: bad request");
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("Hello World");

    const long = "A".repeat(5000);
    await editor.edit("Hello World" + long);

    // Rollback failed but chunks should still be sent
    expect(sentMessages.length).toBe(2);

    const rollbackLog = logCalls.find((l) => l.includes("rollback edit failed"));
    expect(rollbackLog).toBeDefined();
    expect(rollbackLog).toContain("bad request");
  });

  it("handles MESSAGE_TOO_LONG rollback 'not modified' silently", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];
    const logCalls: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async () => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        if (editCalls === 3) {
          throw new Error("400: message is not modified");
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("Hello World");

    const long = "A".repeat(5000);
    await editor.edit("Hello World" + long);

    // Chunks still sent after rollback failure (not-modified is silently swallowed)
    expect(sentMessages.length).toBe(2);
  });

  it("handles MESSAGE_TOO_LONG rollback with parse error in MarkdownV2", async () => {
    let editCalls = 0;
    let nextMsgId = 200;
    const sentMessages: string[] = [];
    const logCalls: string[] = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text) => {
        sentMessages.push(text);
        return { message_id: ++nextMsgId };
      },
      editMessageText: async () => {
        editCalls++;
        if (editCalls === 2) {
          throw new Error("400: MESSAGE_TOO_LONG");
        }
        if (editCalls === 3) {
          // Rollback with MarkdownV2 fails with parse error
          throw new Error("400: can't parse entities");
        }
        if (editCalls === 4) {
          // Rollback plain text succeeds
          return {};
        }
        return {};
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100, (msg) => logCalls.push(msg));

    await editor.edit("Hello World");

    const long = "A".repeat(5000);
    await editor.edit("Hello World" + long);

    // Chunks should still be sent after rollback with parse-error fallback
    expect(sentMessages.length).toBe(2);
    // 4 edit calls: success, MESSAGE_TOO_LONG, parse-error rollback, plain rollback
    expect(editCalls).toBe(4);
  });

  it("sendChunk falls back to plain text on parse error", async () => {
    let chunkCallCount = 0;
    let nextMsgId = 200;
    const sentMessages: Array<{ text: string; parseMode?: string }> = [];

    const api: TelegramApi = {
      sendMessage: async (_cid, text, other) => {
        chunkCallCount++;
        if (chunkCallCount % 2 === 1) {
          // Every first attempt per chunk throws parse error
          throw new Error("400: can't parse entities");
        }
        sentMessages.push({ text, parseMode: other?.parse_mode as string });
        return { message_id: ++nextMsgId };
      },
      editMessageText: async (_cid, _mid, _text) => {
        throw new Error("400: MESSAGE_TOO_LONG");
      },
      sendChatAction: async () => {},
      getFile: async () => ({ file_path: "test" }),
    };

    const editor = createSafeEditor(api, 123, 100);

    const text = "A".repeat(5000);
    await editor.edit(text);

    // 2 chunks, each retried once after parse error → 4 sendMessage calls
    expect(chunkCallCount).toBe(4);
    expect(sentMessages.length).toBe(2);
    // Both chunks succeeded via plain-text fallback
    expect(sentMessages[0]).toEqual(
      expect.objectContaining({ text: "A".repeat(4000), parseMode: undefined }),
    );
    expect(sentMessages[1]).toEqual(
      expect.objectContaining({ text: "A".repeat(1000), parseMode: undefined }),
    );
  });
});
