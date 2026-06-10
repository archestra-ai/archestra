// Render-loop diagnostics for owned MCP Apps. The injected runtime bridge and
// the sandbox proxy forward runtime errors / CSP violations out of the app
// iframe; McpAppRuntime validates and reports them here; the chat send path
// drains them once onto the outgoing user message (metadata.appDiagnostics) so
// the model sees what actually broke in the last render.
//
// The payloads originate inside an UNTRUSTED iframe (a shared team app can
// forge anything), so everything is validated, truncated, capped, and deduped
// before storage — and the prompt-side rendering frames them as data, not
// instructions.

export type AppDiagnosticType =
  | "error"
  | "unhandledrejection"
  | "console.error"
  | "csp-violation";

export interface AppDiagnosticEntry {
  type: AppDiagnosticType;
  message: string;
}

export interface AppDiagnostics {
  appId: string;
  /** App version the diagnostics were captured against (null when unknown). */
  version: number | null;
  entries: AppDiagnosticEntry[];
}

export const MAX_DIAGNOSTICS_PER_APP = 20;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;
// Dedup window: two entries with the same type and message prefix are one.
const DEDUP_PREFIX_LENGTH = 120;

const DIAGNOSTIC_TYPES: readonly AppDiagnosticType[] = [
  "error",
  "unhandledrejection",
  "console.error",
  "csp-violation",
];

/**
 * Validate a payload forwarded from the sandbox (runtime-error or
 * csp-violation message) into a diagnostic entry. Returns null for anything
 * malformed — the inner frame can post arbitrary data.
 */
export function parseForwardedDiagnostic(
  data: unknown,
): AppDiagnosticEntry | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;

  if (record.type === "mcp-apps:runtime-error") {
    const errorType = record.errorType;
    if (
      typeof errorType !== "string" ||
      !DIAGNOSTIC_TYPES.includes(errorType as AppDiagnosticType) ||
      errorType === "csp-violation"
    ) {
      return null;
    }
    if (typeof record.message !== "string" || record.message.length === 0) {
      return null;
    }
    return {
      type: errorType as AppDiagnosticType,
      message: record.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    };
  }

  if (record.type === "mcp-apps:csp-violation") {
    const directive =
      typeof record.directive === "string" ? record.directive : "unknown";
    const blockedUri =
      typeof record.blockedUri === "string" ? record.blockedUri : "unknown";
    return {
      type: "csp-violation",
      message: `CSP violation: ${directive} blocked ${blockedUri}`.slice(
        0,
        MAX_DIAGNOSTIC_MESSAGE_LENGTH,
      ),
    };
  }

  return null;
}

type Listener = () => void;

const diagnosticsByApp = new Map<string, AppDiagnostics>();
const listeners = new Set<Listener>();
// Immutable snapshot of per-app entry counts for useSyncExternalStore.
let countsSnapshot: ReadonlyMap<string, number> = new Map();

function emit() {
  countsSnapshot = new Map(
    [...diagnosticsByApp.entries()].map(([appId, d]) => [
      appId,
      d.entries.length,
    ]),
  );
  for (const listener of listeners) listener();
}

function dedupKey(entry: AppDiagnosticEntry): string {
  return `${entry.type}:${entry.message.slice(0, DEDUP_PREFIX_LENGTH)}`;
}

// Several mounts of the same app can report concurrently (the old create_app
// card and the new update_app card both render the head version), so reports
// are ordered by version: a newer version resets the collection, an older
// (stale-labeled) mount is ignored, equal versions append. Unknown versions
// rank below any known one.
const versionRank = (version: number | null) => version ?? -1;

/**
 * Record a diagnostic for an owned app render. Entries are deduped by
 * type+message-prefix and capped per app; see version ordering above.
 */
export function reportAppDiagnostic(
  appId: string,
  version: number | null,
  entry: AppDiagnosticEntry,
): void {
  let current = diagnosticsByApp.get(appId);
  if (current && versionRank(version) < versionRank(current.version)) {
    return;
  }
  if (!current || versionRank(version) > versionRank(current.version)) {
    current = { appId, version, entries: [] };
    diagnosticsByApp.set(appId, current);
  }
  if (current.entries.length >= MAX_DIAGNOSTICS_PER_APP) return;
  const key = dedupKey(entry);
  if (current.entries.some((e) => dedupKey(e) === key)) return;
  current.entries.push(entry);
  emit();
}

/** Drop everything (conversation switch / chat mount). */
export function clearAllAppDiagnostics(): void {
  if (diagnosticsByApp.size === 0) return;
  diagnosticsByApp.clear();
  emit();
}

/**
 * Attach-once: return every app's non-empty diagnostics and clear the store.
 * Called by the chat send path; a regenerate/retry never re-attaches.
 */
export function drainAppDiagnostics(): AppDiagnostics[] {
  const drained = [...diagnosticsByApp.values()].filter(
    (d) => d.entries.length > 0,
  );
  if (diagnosticsByApp.size > 0) {
    diagnosticsByApp.clear();
    emit();
  }
  return drained;
}

/** useSyncExternalStore subscription for error badges. */
export function subscribeAppDiagnostics(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAppDiagnosticCounts(): ReadonlyMap<string, number> {
  return countsSnapshot;
}
