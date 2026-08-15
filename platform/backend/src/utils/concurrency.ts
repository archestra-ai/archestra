/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order. Used to bound fan-outs against external APIs — full parallelism
 * across a large item set trips server-side throttling (the Kubernetes API
 * server's Priority & Fairness 429s, Bedrock InvokeModel rate limits). Per-item
 * failures are captured, not thrown, mirroring `Promise.allSettled`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await fn(items[index] as T),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
