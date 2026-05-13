// pi-client.ts — Pi RPC subprocess client
// Handles spawn, JSONL framing, send, and event callbacks

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

export interface PiClient {
  readonly pid: number | undefined;
  send(cmd: Record<string, unknown>): void;
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

  proc.on("exit", (code: number | null) => {
    options.onExit?.(code);
  });

  proc.on("error", (err: Error) => {
    options.onError?.(err);
  });

  attachJsonlReader(proc.stdout!, (line: string) => {
    options.onLine?.(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    options.onEvent(event);
  });

  return {
    get pid() {
      return proc.pid;
    },
    send(cmd: Record<string, unknown>): void {
      if (!proc.stdin) {
        console.error("[pi] cannot send command: stdin unavailable");
        return;
      }
      const raw = JSON.stringify(cmd);
      proc.stdin.write(raw + "\n");
    },
    close(): void {
      proc.kill();
    },
  };
}
