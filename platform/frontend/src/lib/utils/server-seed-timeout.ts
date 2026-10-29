/**
 * Run a server render's backend read with a deadline. A page that seeds data
 * into its HTML waits for these reads before it sends anything, so a stuck
 * backend must cost at most this long; the page then renders unseeded and the
 * browser loads the data as it would have. The read gets the signal, so a
 * fetch that honours it is cancelled rather than left running.
 */
export async function withServerSeedDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SERVER_SEED_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Server seed read exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const SERVER_SEED_TIMEOUT_MS = 2_000;
