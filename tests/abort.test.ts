import { describe, expect, it } from "bun:test";
import { Gateway } from "../index";
import type { PiResponse } from "../pi-client";
import type { TelegramApi } from "../telegram";

// requestPi stub: records commands; clear_queue resolves with `clearResp`
// (undefined = never resolves, to exercise the timeout fallback)
function makeAbortGateway(clearResp?: Partial<PiResponse>): { gateway: Gateway; piCommands: Record<string, unknown>[]; messages: string[] } {
  const piCommands: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const api: TelegramApi = {
    sendMessage: async (_chatId: number | string, text: string) => { messages.push(text); return { message_id: 1 }; },
    editMessageText: async () => undefined,
  };
  const gateway = new Gateway({ allowedUserId: 123, api });
  gateway.requestPi = (cmd) => {
    piCommands.push(cmd);
    if (cmd.type === "clear_queue" && !clearResp) return new Promise(() => {});
    return Promise.resolve({ type: "response", command: String(cmd.type), success: true, ...(cmd.type === "clear_queue" ? clearResp : {}) });
  };
  return { gateway, piCommands, messages };
}

describe("Gateway.abortPi", () => {
  it("sends clear_queue before abort and resets streaming state", () => {
    const { gateway, piCommands } = makeAbortGateway({ data: { steering: [], followUp: [] } });
    gateway.piStreaming = true;
    gateway.turnToolCounts.set("bash", 2);
    void gateway.abortPi(123);
    expect(piCommands).toEqual([{ type: "clear_queue" }, { type: "abort" }]);
    expect(gateway.piStreaming).toBe(false);
    expect(gateway.turnToolCounts.size).toBe(0);
  });

  it("prepends cleared counts to the abort reply", async () => {
    const { gateway, messages } = makeAbortGateway({ data: { steering: ["a"], followUp: ["b", "c"] } });
    await gateway.abortPi(123);
    expect(messages).toEqual(["🛑 Aborted. Cleared 3 queued messages."]);
  });

  it("falls back to a plain abort reply when clear_queue fails", async () => {
    const { gateway, messages } = makeAbortGateway({ success: false, error: "boom" });
    await gateway.abortPi(123);
    expect(messages).toEqual(["🛑 Aborted."]);
  });

  it("replies plain abort after the 1500ms timeout when clear_queue never answers", async () => {
    const { gateway, messages } = makeAbortGateway();
    const started = Date.now();
    await gateway.abortPi(123);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(messages).toEqual(["🛑 Aborted."]);
  });
});
