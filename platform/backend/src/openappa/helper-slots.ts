/**
 * The sandbox executions battery helpers may hold at once. A consult over the
 * cap waits, oldest first, for a running one to end instead of failing at once.
 */
export class HelperSlots {
  /** Executions in flight, a raced-out run included until it settles. */
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly cap: () => number) {}

  /** Take a slot, waiting for one until `deadline` (epoch ms); false when none freed up. */
  acquire(deadline: number): Promise<boolean> {
    if (this.inFlight < this.cap()) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const handOver = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          this.waiting.splice(this.waiting.indexOf(handOver), 1);
          resolve(false);
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiting.push(handOver);
    });
  }

  /** End an execution: its slot passes to the oldest waiting consult, if the cap still has room. */
  release(): void {
    const next = this.inFlight <= this.cap() ? this.waiting.shift() : undefined;
    if (next) next();
    else this.inFlight--;
  }
}
