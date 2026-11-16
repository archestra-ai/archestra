import { requestScope } from "@/auth/request-scope";
import config from "@/config";
import { cachePoolReads } from "@/database";
import logger from "@/logging";
import { configCache } from "@/services/config-cache";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * A site whose database is in another cloud or region
 * (`ARCHESTRA_SITE_REMOTE_DATABASE`). Every statement there is a cross-cloud
 * round trip, so an LLM proxy request avoids them: it reads configuration
 * from the pool read cache and records its log and spend after the response.
 * See `sites/README.md`.
 */

/** Install the pool read cache when this site is far from its database. */
export function startRemoteDatabaseMode(): void {
  if (!config.site.remoteDatabase) return;
  cachePoolReads({
    read: (key, load) => configCache.read(key, load),
    inScope: () => requestScope.cachesReads(),
  });
  logger.info(
    { site: config.site.name },
    "Remote database: LLM proxy requests read configuration from a per-pod cache and record logs and spend after the response",
  );
}

/**
 * Run `write` now, or, on a site far from its database, after the response:
 * it resolves once the write is queued and `written` settles when it lands.
 * A queued write is retried for a couple of minutes, so it must be
 * idempotent. When the queue is full the write runs now, so a database
 * outage slows requests down rather than losing their records.
 */
export async function writeAfterResponse(
  what: string,
  write: () => Promise<void>,
): Promise<{ written: Promise<void> }> {
  if (!config.site.remoteDatabase || pending >= MAX_PENDING_WRITES) {
    await write();
    return { written: Promise.resolve() };
  }
  pending++;
  const written = writeWithRetry(what, write).finally(() => {
    pending--;
  });
  trackBackgroundWork(written);
  // Failures are logged where they happen; a caller chaining on `written`
  // still sees them.
  written.catch(() => {});
  return { written };
}

// === Internal helpers ===

/** Writes queued or in flight on this process before new ones run inline. */
const MAX_PENDING_WRITES = 1_000;
/** Queued writes sent to the database at once. */
const WRITE_CONCURRENCY = 8;
/** How long a queued write keeps retrying before it is dropped and logged. */
const RETRY_FOR_MS = 120_000;
const FIRST_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 15_000;

let pending = 0;
let running = 0;
const waiting: Array<() => void> = [];

async function writeWithRetry(
  what: string,
  write: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  let delay = FIRST_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    await acquire();
    try {
      await write();
      return;
    } catch (error) {
      if (Date.now() - startedAt + delay > RETRY_FOR_MS) {
        logger.error(
          { err: error, what, attempts: attempt },
          "Dropped a write queued after the response",
        );
        throw error;
      }
      logger.warn(
        { err: error, what, attempt },
        "A write queued after the response failed; retrying",
      );
    } finally {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function acquire(): Promise<void> {
  if (running < WRITE_CONCURRENCY) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}
