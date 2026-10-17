import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPiClient } from "../pi-client";

const FAKE_PI = join(import.meta.dirname, "fixtures", "fake-pi.ts");

function startFakePi() {
  const events: Array<Record<string, unknown>> = [];
  let exited: (code: number | null) => void = () => {};
  const exit = new Promise<number | null>((resolve) => { exited = resolve; });
  const client = createPiClient({
    path: process.execPath,
    args: [FAKE_PI],
    env: process.env,
    onEvent: (event) => { events.push(event as Record<string, unknown>); },
    onStderr: () => {},
    onExit: (code) => exited(code),
  });
  return { client, events, exit };
}

describe("PiClient.request", () => {
  it("resolves with the response matching its id, without emitting it as an event", async () => {
    const { client, events } = startFakePi();
    const [a, b] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "set_session_name", name: "x" }),
    ]);
    client.close();

    expect(a.success).toBe(true);
    expect(a.command).toBe("get_state");
    expect(b.command).toBe("set_session_name");
    expect((b.data as { echo: Record<string, unknown> }).echo).toEqual({ type: "set_session_name", name: "x", id: b.id });
    expect(a.id).not.toBe(b.id);
    expect(events).toEqual([]);
  });

  it("passes id-carrying events (e.g. bash_execution_update) to onEvent, before the response resolves", async () => {
    const { client, events } = startFakePi();
    const resp = await client.request({ type: "bash", command: "echo" });
    client.close();

    expect(resp.command).toBe("bash");
    expect(events.map((e) => e.type)).toEqual(["bash_execution_update"]);
    expect(events[0]!.id).toBe(resp.id);
  });

  it("resolves pending requests with success=false when pi exits", async () => {
    const { client, exit } = startFakePi();
    const pending = client.request({ type: "hang" });
    client.request({ type: "exit" });

    const resp = await pending;
    expect(await exit).toBe(3);
    expect(resp.success).toBe(false);
    expect(resp.error).toBe("pi exited (code=3)");
  });
});
