import { mkdir, readdir, readFile, unlink } from "node:fs/promises";

export class InjectWatcher {
  private dir: string;
  private onPrompt: (text: string, filename: string) => void;
  private pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dir: string, onPrompt: (text: string, filename: string) => void, pollMs = 12000) {
    this.dir = dir;
    this.onPrompt = onPrompt;
    this.pollMs = pollMs;
  }

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const entries = await readdir(this.dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name;

        const filepath = `${this.dir}/${name}`;

        let text: string;
        try {
          text = await readFile(filepath, "utf-8");
        } catch (err) {
          console.error(`[inject] read error: ${name} — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        if (!text.trim()) {
          await this.tryUnlink(filepath);
          continue;
        }

        // Delete BEFORE calling onPrompt — if injection crashes, file is already consumed
        await this.tryUnlink(filepath);

        try {
          this.onPrompt(text.trim(), name);
        } catch (err) {
          console.error(`[inject] onPrompt threw for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      console.error(`[inject] scan error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async tryUnlink(filepath: string): Promise<void> {
    try {
      await unlink(filepath);
    } catch (err) {
      console.error(`[inject] unlink error: ${filepath} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
