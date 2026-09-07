import { closeSync, constants, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Messages a human sent into a live session, delivered at turn boundaries.
 *
 * The control plane writes one line per message into a FIFO. Reading it as
 * lines is what makes a steer atomic: a message can never be spliced into the
 * middle of a tool call, which is the failure the FIFO exists to avoid.
 *
 * Keep a nonblocking reader open across writer disconnects. EOF means no
 * current writer, not that this long-lived steering channel has ended.
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
      let fd: number | undefined;
      try {
        // Blocking FIFO opens/reads cannot be cancelled on shutdown. Keeping
        // this nonblocking descriptor also avoids losing writes during reopen.
        fd = openSync(this.fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);
        const buffer = Buffer.alloc(65536);
        const decoder = new StringDecoder("utf8");
        let pending = "";
        while (!this.stopped) {
          let bytes = 0;
          try {
            bytes = readSync(fd, buffer, 0, buffer.length, null);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
          }
          if (bytes > 0) {
            pending += decoder.write(buffer.subarray(0, bytes));
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
              this.enqueue(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
              newline = pending.indexOf("\n");
            }
          }
          await delay(100);
        }
      } catch (error) {
        if (!this.stopped) this.onError(error);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      if (!this.stopped) await delay(100);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
