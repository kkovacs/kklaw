import { describe, expect, it } from "bun:test";
import { Gateway } from "../index";
import type { TelegramApi } from "../telegram";

const api: TelegramApi = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessageText: async () => undefined,
};

function makeAbortGateway(): { gateway: Gateway; piCommands: Record<string, unknown>[] } {
  const piCommands: Record<string, unknown>[] = [];
  const gateway = new Gateway({ allowedUserId: 123, api });
  gateway.sendPi = (cmd) => { piCommands.push(cmd); };
  return { gateway, piCommands };
}

describe("Gateway.abortPi", () => {
  it("sends clear_queue (with id) before abort", () => {
    const { gateway, piCommands } = makeAbortGateway();
    void gateway.abortPi(123);
    expect(piCommands.length).toBe(2);
    expect(piCommands[0]!.type).toBe("clear_queue");
    expect(typeof piCommands[0]!.id).toBe("string");
    expect(piCommands[1]).toEqual({ type: "abort" });
  });

  it("prepends cleared counts to the abort reply", async () => {
    const { gateway, piCommands } = makeAbortGateway();
    const messages: string[] = [];
    gateway.api = { ...api, sendMessage: async (_chatId: number | string, text: string) => { messages.push(text); return { message_id: 1 } } };
    const sent = gateway.abortPi(123);
    const clearId = piCommands[0]!.id as string;
    expect(gateway.abortPending.has(clearId)).toBe(true);

    // Delivered clear_queue response with 3 queued messages
    await gateway.handlePiEvent({
      type: "response", id: clearId, command: "clear_queue", success: true,
      data: { steering: ["a"], followUp: ["b", "c"] },
    } as never);
    expect(gateway.abortPending.has(clearId)).toBe(false);
    await sent;
    expect(messages).toEqual(["🛑 Aborted. Cleared 3 queued messages."]);

    // Late duplicate response after the entry fired → inert, no second reply
    await gateway.handlePiEvent({
      type: "response", id: clearId, command: "clear_queue", success: true,
      data: { steering: ["a"], followUp: ["b", "c"] },
    } as never);
    expect(messages).toEqual(["🛑 Aborted. Cleared 3 queued messages."]);

    // Unknown correlation id → swallowed, no reply
    await gateway.handlePiEvent({
      type: "response", id: "clear-bogus", command: "clear_queue", success: true,
      data: { steering: [], followUp: [] },
    } as never);
    expect(gateway.abortPending.size).toBe(0);
  });

  it("falls back to a plain abort reply when clear_queue fails", async () => {
    const { gateway, piCommands } = makeAbortGateway();
    const messages: string[] = [];
    gateway.api = { ...api, sendMessage: async (_chatId: number | string, text: string) => { messages.push(text); return { message_id: 1 } } };
    const sent = gateway.abortPi(123);
    const clearId = piCommands[0]!.id as string;
    await gateway.handlePiEvent({
      type: "response", id: clearId, command: "clear_queue", success: false, error: "boom",
    } as never);
    await sent;
    expect(messages).toEqual(["🛑 Aborted."]);
  });
});
