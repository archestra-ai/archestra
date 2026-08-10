// Serializes writes of a single value to one destination, keeping only the
// newest. It sits apart from the chat page's thinking-effort handler so the
// ordering contract can be unit-tested; that component is too large to
// exercise it reliably.
//
// The subtlety this encodes: two PATCHes to the same row can settle out of
// order, and the loser writes last — so correcting a mis-click on a two-option
// control could leave the server holding the option the user just abandoned.
// Running one request at a time makes the newest choice the one that lands.
// Intermediate values are dropped rather than queued: only where the user
// stopped clicking matters.

export type LatestWriteQueue<T> = {
  /** Record a new value and start (or join) the run that persists it. */
  set: (value: T) => void;
  /** The in-flight run, or null when idle. Await it before reading the row. */
  readonly pending: Promise<void> | null;
};

export function createLatestWriteQueue<T>(
  write: (value: T) => Promise<unknown>,
): LatestWriteQueue<T> {
  let pending: Promise<void> | null = null;
  let desired: { value: T } | null = null;

  const drain = async () => {
    while (desired !== null) {
      const next = desired.value;
      desired = null;
      // Swallowed so an awaiting caller is not rejected by a failed write; the
      // caller's own error handling still runs.
      await write(next).catch(() => undefined);
    }
  };

  return {
    set(value: T) {
      desired = { value };
      if (pending) {
        return;
      }
      const run = drain();
      pending = run;
      void run.finally(() => {
        if (pending === run) {
          pending = null;
        }
      });
    },
    get pending() {
      return pending;
    },
  };
}
