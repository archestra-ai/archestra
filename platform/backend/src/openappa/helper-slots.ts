/**
 * The sandbox executions battery helpers may hold at once. A consult over the
 * cap waits, oldest first, for a running one to end instead of failing at once.
 */
export class HelperSlots {
  /** Executions in flight, a raced-out run included until it settles. */
  private inFlight = 0;
  private readonly waiting: Array<{
    deadline: number;
    handOver: () => void;
  }> = [];

  constructor(private readonly cap: () => number) {}

  /** Take a slot, waiting for one until `deadline` (epoch ms); false when none freed up. */
  acquire(deadline: number): Promise<boolean> {
    if (this.inFlight < this.cap()) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        deadline,
        handOver: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(
        () => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          resolve(false);
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiting.push(waiter);
    });
  }

  /**
   * End an execution: its slot passes to the oldest consult still within its
   * wait, if the cap still has room.
   */
  release(): void {
    if (this.inFlight <= this.cap()) {
      const now = Date.now();
      const next = this.waiting.findIndex((waiter) => waiter.deadline > now);
      if (next >= 0) {
        // Waiters before it are past their deadline; their timers turn them away.
        const [waiter] = this.waiting.splice(next, 1);
        waiter.handOver();
        return;
      }
    }
    this.inFlight--;
  }
}
