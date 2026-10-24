import { AsyncResource } from "node:async_hooks";

/**
 * Simple async queue to serialize operations per connection
 * Prevents concurrent MCP calls to the same server (important for stdio transport)
 */
export class ConnectionLimiter {
  private states = new Map<string, QueueState>();

  /**
   * Execute a function with a per-connection concurrency limit.
   */
  runWithLimit<T>(
    connectionKey: string,
    limit: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (limit <= 0) {
      return fn();
    }

    const state = this.states.get(connectionKey) ?? {
      activeCount: 0,
      queue: [],
    };
    this.states.set(connectionKey, state);

    return new Promise<T>((resolve, reject) => {
      // A queued call starts from the releasing call's continuation. Bound to
      // the caller's async context, it keeps its own request's scope and trace
      // instead of inheriting the call that happened to finish first.
      const execute = AsyncResource.bind(() => {
        state.activeCount += 1;
        // Adopt the complete operation, including its recursive retries, before
        // releasing this lease. A retry must not acquire a second limiter slot.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            state.activeCount -= 1;
            const next = state.queue.shift();
            if (next) {
              next();
              return;
            }
            if (state.activeCount === 0) {
              this.states.delete(connectionKey);
            }
          });
      });

      if (state.activeCount < limit) {
        execute();
        return;
      }

      state.queue.push(execute);
    });
  }
}

type QueueState = {
  activeCount: number;
  queue: Array<() => void>;
};
