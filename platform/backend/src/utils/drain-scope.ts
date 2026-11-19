import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Keep loopback calls attached to the work that admitted them. A process-wide
 * internal-call proof alone cannot distinguish a running turn from a new job.
 */
export function withDrainScope<T>(run: () => T, continuation?: string): T {
  const inherited = continuation ?? scope.getStore();
  const token = inherited && live.has(inherited) ? inherited : randomUUID();
  live.set(token, (live.get(token) ?? 0) + 1);
  const release = () => {
    const remaining = (live.get(token) ?? 1) - 1;
    if (remaining) live.set(token, remaining);
    else live.delete(token);
  };
  try {
    const result = scope.run(token, run);
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    )
      return Promise.resolve(result).finally(release) as T;
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

/** Resolve at send time: cached clients must not retain a previous turn's scope. */
export function drainScopeHeaders(): Record<string, string> {
  const token = scope.getStore();
  return token && live.has(token) ? { [HEADER]: token } : {};
}

/** Consume before auth/schema hooks or forwarding can expose this local proof. */
export function takeDrainScope(request: {
  headers: Headers;
  raw?: { headers: Headers; rawHeaders?: string[] };
}): string | undefined {
  const token = request.headers[HEADER];
  for (const headers of new Set([request.headers, request.raw?.headers])) {
    if (headers) delete headers[HEADER];
  }
  const rawHeaders = request.raw?.rawHeaders;
  if (rawHeaders) {
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      if (rawHeaders[i].toLowerCase() === HEADER) rawHeaders.splice(i, 2);
    }
  }
  return typeof token === "string" && live.has(token) ? token : undefined;
}

type Headers = Record<string, string | string[] | undefined>;
const HEADER = "x-archestra-drain-scope";
const scope = new AsyncLocalStorage<string>();
const live = new Map<string, number>();
