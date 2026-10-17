// pi-client.ts — Pi RPC subprocess client
// Handles spawn, JSONL framing, send/request, and event callbacks

import { spawn, type ChildProcess } from "node:child_process";

// Splits only on \n — Node's readline splits on Unicode line sep. too
function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
}

export interface PiResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiClient {
  readonly pid: number | undefined;
  // Sends cmd with a fresh id; resolves with the matching response. Never
  // rejects: pi exit/spawn error resolves pending requests with success=false.
  request(cmd: Record<string, unknown>): Promise<PiResponse>;
  close(): void;
}

export function createPiClient(options: {
  path: string;
  args: string[];
  env: Record<string, string | undefined>;
  onEvent(event: unknown): void;
  onLine?(line: string): void;
  onStderr?(data: Buffer | string): void;
  onExit?(code: number | null): void;
  onError?(err: Error): void;
}): PiClient {
  const proc = spawn(options.path, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
  });

  proc.stderr?.on("data", (data: Buffer | string) => {
    if (options.onStderr) options.onStderr(data);
    else process.stderr.write(`[pi] ${data}`);
  });

  // In-flight request() calls: id → resolver. Responses with a known id are
  // consumed here and not passed to onEvent.
  const pending = new Map<string, (resp: PiResponse) => void>();
  let seq = 0;
  const failPending = (error: string) => {
    for (const [id, resolve] of pending) resolve({ type: "response", id, success: false, error });
    pending.clear();
  };

  proc.on("exit", (code: number | null) => {
    failPending(`pi exited (code=${code})`);
    options.onExit?.(code);
  });

  proc.on("error", (err: Error) => {
    failPending(`pi error: ${err.message}`);
    options.onError?.(err);
  });

  let eventQueue = Promise.resolve();

  attachJsonlReader(proc.stdout!, (line: string) => {
    options.onLine?.(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      console.error(`[pi] malformed JSON line: ${line.slice(0, 200)}`);
      return;
    }
    // Only responses: some events (e.g. bash_execution_update) carry the request id too.
    // Resolved via eventQueue so earlier events are handled before the awaiting caller resumes.
    const resp = event as PiResponse;
    if (resp?.type === "response" && resp.id !== undefined) {
      const resolve = pending.get(resp.id);
      if (resolve) {
        pending.delete(resp.id);
        eventQueue = eventQueue.then(() => resolve(resp));
        return;
      }
    }
    eventQueue = eventQueue.then(() => (options.onEvent(event) as Promise<void> | undefined)?.catch((err: Error) => {
      console.error(`[pi] event handler error: ${err.message}`);
    }));
  });

  function send(cmd: Record<string, unknown>): void {
    if (!proc.stdin) {
      console.error("[pi] cannot send command: stdin unavailable");
      return;
    }
    const raw = JSON.stringify(cmd);
    proc.stdin.write(raw + "\n", (err) => {
      if (err) console.error(`[pi] stdin write failed: ${err.message}`);
    });
  }

  return {
    get pid() {
      return proc.pid;
    },
    request(cmd: Record<string, unknown>): Promise<PiResponse> {
      const id = `r${++seq}`;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ ...cmd, id });
      });
    },
    close(): void {
      proc.kill();
    },
  };
}
