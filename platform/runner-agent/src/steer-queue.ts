import { createReadStream, type ReadStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";

/**
 * Messages a human sent into a live session, delivered at turn boundaries.
 *
 * The control plane writes one line per message into a FIFO. Reading it as
 * lines is what makes a steer atomic: a message can never be spliced into the
 * middle of a tool call, which is the failure the FIFO exists to avoid.
 *
 * A FIFO returns EOF every time the last writer closes, so the reader reopens
 * in a loop. Without that the queue would go deaf after the first message.
 */
export class SteerQueue {
  private readonly pending: string[] = [];
  private stopped = false;
  private stream: ReadStream | null = null;
  private lines: Interface | null = null;

  constructor(
    private readonly fifoPath: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    void this.readForever();
  }

  stop(): void {
    this.stopped = true;
    this.lines?.close();
    this.stream?.destroy();
  }

  /** Take everything queued since the last call, oldest first. */
  drain(): string[] {
    return this.pending.splice(0, this.pending.length);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Queue a complete line read directly from the attached terminal. */
  enqueue(message: string): void {
    const normalized = message.trim();
    if (normalized) this.pending.push(normalized);
  }

  /**
   * Block until a message arrives, or until `timeoutMs` passes with nothing.
   *
   * The timeout is the session's finish contract: a task that has done its
   * work parks here briefly in case a human wants to steer it further, and
   * exits cleanly when nobody does — which is what lets the Job complete and
   * the task settle instead of a session that never ends. `null` waits
   * forever (interactive sessions that are meant to be parked).
   */
  async waitForMessage(timeoutMs: number | null = null): Promise<string[]> {
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    while (!this.stopped) {
      if (this.pending.length > 0) {
        return this.drain();
      }
      if (deadline !== null && Date.now() >= deadline) {
        return [];
      }
      await delay(500);
    }
    return [];
  }

  private async readForever(): Promise<void> {
    while (!this.stopped) {
      try {
        const stream = createReadStream(this.fifoPath);
        const lines = createInterface({ input: stream });
        this.stream = stream;
        this.lines = lines;
        for await (const line of lines) {
          this.enqueue(line);
        }
        lines.close();
      } catch (error) {
        if (!this.stopped) {
          this.onError(error);
          await delay(1000);
        }
      } finally {
        this.lines = null;
        this.stream = null;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
