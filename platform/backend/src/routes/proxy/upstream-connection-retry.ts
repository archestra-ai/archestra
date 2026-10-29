/**
 * Sends an upstream model call again when its connection failed before the
 * provider answered.
 *
 * The proxy otherwise relays provider failures instead of retrying them (see
 * adapters/sdk-retry-policy.ts). A connection that fails before the first
 * chunk is different: no answer has reached the client, so a second attempt
 * cannot duplicate client output. This does not guarantee that the provider
 * did no work or incurred no cost on the failed attempt. Once a chunk has
 * arrived, a failure still goes to the client, because it cannot accept a
 * second answer in its place.
 */
export async function openUpstreamWithRetry<T>(params: {
  /** Opens the upstream call. Called once per attempt. */
  open: () => Promise<T>;
  /** Whether a failure is safe to send again. */
  isRetryable: (error: unknown) => boolean;
  /** False once nobody waits for the answer, for example after the client left. */
  shouldContinue: () => boolean;
  onRetry?: (event: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
  /** Wait before each retry. Its length is the number of retries. */
  delaysMs?: readonly number[];
}): Promise<T> {
  if (!params.shouldContinue()) {
    throw new DOMException("The proxy client disconnected", "AbortError");
  }
  const delaysMs = params.delaysMs ?? UPSTREAM_RETRY_DELAYS_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await params.open();
    } catch (error) {
      const delayMs = delaysMs[attempt - 1];
      if (
        delayMs === undefined ||
        !params.isRetryable(error) ||
        !params.shouldContinue()
      ) {
        throw error;
      }
      params.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
      if (!params.shouldContinue()) {
        throw error;
      }
    }
  }
}

/**
 * Reads the first chunk of a stream now, so a connection that fails before
 * the provider answers fails inside {@link openUpstreamWithRetry} and not in
 * the caller's loop. The returned stream yields that chunk first. If the
 * caller stops early, the upstream stream is closed, as `for await` would.
 */
export async function withFirstChunk<T>(
  stream: AsyncIterable<T>,
): Promise<AsyncIterable<T>> {
  const iterator = stream[Symbol.asyncIterator]();
  let first: IteratorResult<T>;
  try {
    first = await iterator.next();
  } catch (error) {
    // Release a failed attempt before opening another, preserving its cause.
    try {
      await iterator.return?.();
    } catch {
      // Cleanup must not replace the transport error used to classify retries.
    }
    throw error;
  }
  let consumed = false;
  return {
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error("This upstream stream can be read only once");
      }
      consumed = true;
      return replay(first, iterator);
    },
  };
}

// === Internal helpers ===

/** Waits before the second and the third attempt. */
const UPSTREAM_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

async function* replay<T>(
  first: IteratorResult<T>,
  iterator: AsyncIterator<T>,
): AsyncGenerator<T> {
  // True once the upstream iterator has ended or failed by itself. Only a
  // caller that stops early leaves it open, and only then is it closed here.
  let upstreamEnded = first.done === true;
  try {
    if (upstreamEnded) return;
    yield first.value;
    for (;;) {
      let next: IteratorResult<T>;
      try {
        next = await iterator.next();
      } catch (error) {
        upstreamEnded = true;
        throw error;
      }
      if (next.done) {
        upstreamEnded = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!upstreamEnded) {
      await iterator.return?.();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
