/**
 * Serve some standalone SELECTs from a per-process cache, for a site whose
 * database is in another cloud or region (`ARCHESTRA_SITE_REMOTE_DATABASE`).
 * There every statement is a cross-cloud round trip, and an LLM proxy request
 * reads a dozen configuration rows before it can call the provider.
 *
 * Only pool queries are considered, so a statement inside a transaction always
 * reads the database. A statement is served from the cache when the caller is
 * inside a scope that opted in (see `install`), it is a plain SELECT, and
 * every table it reads is in {@link CACHEABLE_TABLES}. The cache itself is
 * injected: the configuration cache, which keeps entries a few seconds and
 * drops them all when the database announces a change to one of the tables
 * it watches. See `sites/README.md`.
 */

/**
 * Configuration the LLM proxy reads on each request. A row changed in a
 * table without a change notification is served stale for at most the
 * cache's TTL (seconds); budget usage (`limit_model_usage`) is among them, so
 * a site enforces a limit a few seconds late.
 */
const CACHEABLE_TABLES = new Set([
  "agents",
  "agent_labels",
  "api_key_models",
  "chat_api_keys",
  "connection_setups",
  "environment_default_user_limits",
  "guardrails_deployment",
  "label_keys",
  "label_values",
  "limit_model_usage",
  "limits",
  "member",
  "model_pool_members",
  "model_pool_virtual_api_keys",
  "model_pools",
  "models",
  "oauth_access_token",
  "oauth_client",
  "oauth_client_labels",
  "organization",
  "resource_permission_policies",
  "team",
  "team_labels",
  "team_member",
  "user",
  "user_token",
  "virtual_api_key_labels",
  "virtual_api_key_provider_api_key",
  "virtual_api_keys",
]);

type Read = <T>(key: string, load: () => Promise<T>) => Promise<T>;

type QueryResult = { rows: unknown[] };

/**
 * Wrap `pool.query` so statements the scope allows are read through `read`.
 * Call once, after the pool exists.
 */
export function installPoolReadCache(
  pool: { query: (...args: unknown[]) => unknown },
  params: { read: Read; inScope: () => boolean },
): void {
  const query = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const key =
      typeof args[args.length - 1] === "function" || !params.inScope()
        ? null
        : cacheKey(args[0], args[1]);
    if (key === null) return query(...args);
    return params
      .read(key, () => query(...args) as Promise<QueryResult>)
      .then(copyResult);
  }) as typeof pool.query;
}

/** @public — exported for testability */
export function isCacheableStatement(text: string): boolean {
  if (!/^\s*(select|with)\b/i.test(text)) return false;
  if (
    /\b(insert\s+into|update\s+"|delete\s+from|for\s+(update|share|no\s+key\s+update|key\s+share)|nextval\s*\(|pg_advisory)/i.test(
      text,
    )
  )
    return false;
  const cteNames = new Set(
    [...text.matchAll(/(?:\bwith|,)\s+"([a-z0-9_]+)"\s+as\s*\(/gi)].map(
      (match) => match[1],
    ),
  );
  const tables = [...text.matchAll(/\b(?:from|join)\s+"([a-z0-9_]+)"/gi)]
    .map((match) => match[1])
    .filter((table) => !cteNames.has(table));
  return (
    tables.length > 0 && tables.every((table) => CACHEABLE_TABLES.has(table))
  );
}

// === Internal helpers ===

/** `query(text, values)` or `query({ text, values?, rowMode? }, values?)`. */
function cacheKey(first: unknown, second: unknown): string | null {
  const config = (typeof first === "string" ? { text: first } : first) as
    | { text?: unknown; values?: unknown; rowMode?: unknown }
    | undefined;
  if (typeof config?.text !== "string" || !isCacheableStatement(config.text))
    return null;
  let values: string;
  try {
    values = JSON.stringify(second ?? config.values ?? []);
  } catch {
    return null; // a value JSON can't hold, such as a bigint
  }
  return `sql\0${String(config.rowMode ?? "")}\0${config.text}\0${values}`;
}

/** Callers may change the rows they get; the cached ones must stay intact. */
function copyResult(result: QueryResult): QueryResult {
  return { ...result, rows: structuredClone(result.rows) };
}
