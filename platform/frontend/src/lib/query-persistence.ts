"use client";

import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
} from "@tanstack/react-query";

/**
 * Marks a query as safe to keep across a page refresh.
 *
 * Persistence is opt-in per query, never blanket: the snapshot lives in
 * `sessionStorage`, which any script running on the page can read, so only
 * queries whose payload is already rendered on screen and cheap to re-fetch
 * should carry it. Spread it into the query options:
 *
 * ```ts
 * useQuery({ queryKey, queryFn, meta: PERSISTED_QUERY_META });
 * ```
 */
export const PERSISTED_QUERY_META = { persist: true } as const;

/**
 * Restore the previous snapshot into `client`.
 *
 * Call this once on the client after mount. Queries already in flight keep
 * their `fetchStatus`, so a restored page paints last-known data immediately
 * and swaps in the fresh response in place when it lands.
 */
export function restorePersistedQueryCache(client: QueryClient): void {
  const snapshot = readSnapshot();
  if (!snapshot) return;
  hydrate(client, snapshot.state);
}

/**
 * Mirror `client`'s persistable queries into storage until the returned
 * function is called. Writes are debounced: a page settling in fires dozens of
 * cache events, and only the final one matters.
 */
export function startPersistingQueryCache(client: QueryClient): () => void {
  if (!isStorageAvailable()) return () => undefined;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (timeout) return;
    timeout = setTimeout(() => {
      timeout = null;
      writeSnapshot(client);
    }, WRITE_DEBOUNCE_MS);
  });

  return () => {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
  };
}

/**
 * Point the snapshot at `scope` — a stable id for "this user in this
 * workspace". A scope that does not match the stored one means the browser is
 * now showing somebody else's data (or the same person's other workspace), so
 * both the snapshot and the live cache are dropped rather than reused.
 */
export function syncPersistedQueryCacheScope(
  client: QueryClient,
  scope: string,
): void {
  if (!isStorageAvailable()) return;
  const storedScope = readSnapshot()?.scope;
  if (storedScope === scope) return;
  if (storedScope !== undefined) {
    clearPersistedQueryCache();
    client.clear();
  }
  writeSnapshot(client, scope);
}

/** Drop the snapshot. Called on sign-out and on a scope change. */
export function clearPersistedQueryCache(): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // A storage quota or privacy-mode failure leaves the snapshot in place; it
    // expires on its own and is scope-checked before it is ever reused.
  }
}

// ===========================================================================
// Internals
// ===========================================================================

/**
 * `sessionStorage`, not `localStorage`: the snapshot exists to make a refresh
 * feel instant, and a per-tab store that dies with the tab gives exactly that
 * without leaving an org's data on disk for the next person at the keyboard.
 */
const STORAGE_KEY = "archestra.refresh-cache.v1";
const SNAPSHOT_VERSION = 1;
const MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const MAX_QUERY_BYTES = 300_000;
const WRITE_DEBOUNCE_MS = 500;

/**
 * Field names whose *string* values are dropped on the way into storage.
 * Persisted payloads are things the page already renders, but a response can
 * still carry a credential alongside them (the session object quotes its own
 * token), and nothing the UI reads before revalidation needs one.
 *
 * The string check matters: several of these words are also permission
 * resource names, so the permission map contains `secret: ["read", …]` and
 * `apiKey: ["read", …]`. Redacting those would make a restored page look like
 * the user had lost access to secrets until the refetch landed. A credential
 * is a string; a list of allowed actions is not.
 */
const REDACTED_FIELDS = new Set([
  "accessToken",
  "apiKey",
  "clientSecret",
  "idToken",
  "password",
  "privateKey",
  "refreshToken",
  "secret",
  "token",
]);

type Snapshot = {
  version: number;
  scope: string;
  savedAt: number;
  state: DehydratedState;
};

function readSnapshot(): Snapshot | null {
  if (!isStorageAvailable()) return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: Snapshot;
  try {
    parsed = JSON.parse(raw) as Snapshot;
  } catch {
    clearPersistedQueryCache();
    return null;
  }

  const isUsable =
    parsed?.version === SNAPSHOT_VERSION &&
    typeof parsed.scope === "string" &&
    typeof parsed.savedAt === "number" &&
    Date.now() - parsed.savedAt < MAX_AGE_MS &&
    Array.isArray(parsed.state?.queries);
  if (!isUsable) {
    clearPersistedQueryCache();
    return null;
  }
  return parsed;
}

function writeSnapshot(client: QueryClient, scope?: string): void {
  const resolvedScope = scope ?? readSnapshot()?.scope;
  // Until the session resolves we do not know whose data this is, so there is
  // nothing safe to file it under.
  if (resolvedScope === undefined) return;

  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" && query.meta?.persist === true,
    shouldDehydrateMutation: () => false,
  });

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    scope: resolvedScope,
    savedAt: Date.now(),
    state: { ...state, queries: withinBudget(state.queries) },
  };

  try {
    window.sessionStorage.setItem(STORAGE_KEY, serialize(snapshot));
  } catch {
    // Out of quota or storage disabled — the app is fully functional without
    // a snapshot, so a failed write is not worth surfacing.
  }
}

/**
 * Keep the snapshot small enough to write and to parse on the next boot.
 * Smallest queries win, so one oversized list cannot crowd out the handful of
 * small shell queries that remove the boot loaders.
 */
function withinBudget(
  queries: DehydratedState["queries"],
): DehydratedState["queries"] {
  const sized = queries
    .map((query) => ({ query, bytes: serialize(query).length }))
    .filter(({ bytes }) => bytes <= MAX_QUERY_BYTES)
    .sort((a, b) => a.bytes - b.bytes);

  const kept: DehydratedState["queries"] = [];
  let total = 0;
  for (const { query, bytes } of sized) {
    if (total + bytes > MAX_SNAPSHOT_BYTES) break;
    total += bytes;
    kept.push(query);
  }
  return kept;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (key, fieldValue) =>
    REDACTED_FIELDS.has(key) && typeof fieldValue === "string"
      ? undefined
      : fieldValue,
  );
}

function isStorageAvailable(): boolean {
  return typeof window !== "undefined" && !!window.sessionStorage;
}
