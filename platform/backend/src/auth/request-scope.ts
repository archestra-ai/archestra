import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Caller lookups (principal, role permissions) that one read request shares
 * across the auth middleware, the route and the models it calls. The auth
 * plugin binds a scope to each request. Only reads memoize, so a request that
 * changes roles or teams never sees an answer from before its own write.
 */
class RequestScope {
  private storage = new AsyncLocalStorage<Map<
    string,
    Promise<unknown>
  > | null>();

  /** Start a request's scope. Reads get a memo; other requests get none. */
  enter(params: { memoize: boolean }): void {
    // Always rebinds, so a write on a keep-alive connection never inherits
    // the scope of the read before it.
    this.storage.enterWith(params.memoize ? new Map() : null);
  }

  /** Whether the current request can reuse a combined caller lookup. */
  isMemoizing(): boolean {
    return Boolean(this.storage.getStore());
  }

  /** `load()` once per request and key, or every time outside a read scope. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cache = this.storage.getStore();
    if (!cache) return load();
    const cached = cache.get(key) as Promise<T> | undefined;
    if (cached) return cached;
    const value = load();
    cache.set(key, value);
    // A failed lookup is not remembered, so a retry within the request reads again.
    value.catch(() => cache.delete(key));
    return value;
  }
}

export const requestScope = new RequestScope();

/**
 * True for reads of the REST API: GET and HEAD under /api/. Better Auth's
 * routes under /api/auth/ are excluded, because their sign-in and SSO
 * callbacks write the caller's role and teams during a GET. Long-lived
 * streams, such as the MCP gateway's SSE GET and WebSockets, are outside
 * /api/, so they never keep one answer for hours.
 */
export function shouldShareCallerLookups(request: {
  method: string;
  url: string;
}): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.url.startsWith("/api/") &&
    !request.url.startsWith("/api/auth/")
  );
}
