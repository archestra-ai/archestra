import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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

  constructor(
    private readonly fifoPath: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    void this.readForever();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Take everything queued since the last call, oldest first. */
  drain(): string[] {
    return this.pending.splice(0, this.pending.length);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Block until a message arrives. Used when the agent has finished its work
   * and has nothing to do but wait — a session that idles for a week costs
   * nothing while it is parked here.
   */
  async waitForMessage(): Promise<string[]> {
    while (!this.stopped) {
      if (this.pending.length > 0) {
        return this.drain();
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
        for await (const line of lines) {
          const message = line.trim();
          if (message) {
            this.pending.push(message);
          }
        }
        lines.close();
      } catch (error) {
        this.onError(error);
        await delay(1000);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
