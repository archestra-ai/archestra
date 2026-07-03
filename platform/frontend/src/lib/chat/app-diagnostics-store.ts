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
  | "csp-violation"
  | "render-check"
  | "console.log"
  | "console.warn"
  | "console.info";

// Error-class diagnostics signal an actual failure (rendered prominently);
// the remaining console.{log,warn,info} types are ordinary log output.
// `render-check` is the SDK's proactive render-correctness channel (e.g. a
// `hidden` element left painted by app CSS) — a broken render that throws
// nothing. Only objective contract violations post here, since it gates publish;
// heuristic "looks broken" checks should be advisory, not this class.
const ERROR_DIAGNOSTIC_TYPES: ReadonlySet<AppDiagnosticType> = new Set([
  "error",
  "unhandledrejection",
  "console.error",
  "csp-violation",
  "render-check",
]);

export function isErrorDiagnostic(type: AppDiagnosticType): boolean {
  return ERROR_DIAGNOSTIC_TYPES.has(type);
}

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
  "render-check",
  "console.log",
  "console.warn",
  "console.info",
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

/** Per-app diagnostic counts split into error-class vs ordinary log output. */
export interface AppDiagnosticCounts {
  errors: number;
  logs: number;
}

const diagnosticsByApp = new Map<string, AppDiagnostics>();
// Highest version drained per app. A drain clears the live map, so without this
// a late report from an already-drained older version would see no `current`,
// skip the ordering guard, and mis-attach to a later prompt. Cleared only on
// lifecycle reset, not on drain.
const lastDrainedVersionByApp = new Map<string, number>();
const listeners = new Set<Listener>();
// Immutable snapshot of per-app entry counts for useSyncExternalStore.
let countsSnapshot: ReadonlyMap<string, AppDiagnosticCounts> = new Map();

function emit() {
  countsSnapshot = new Map(
    [...diagnosticsByApp.entries()].map(([appId, d]) => {
      let errors = 0;
      for (const entry of d.entries) {
        if (isErrorDiagnostic(entry.type)) errors += 1;
      }
      return [appId, { errors, logs: d.entries.length - errors }];
    }),
  );
  for (const listener of listeners) listener();
}

function dedupKey(entry: AppDiagnosticEntry): string {
  return `${entry.type}:${entry.message.slice(0, DEDUP_PREFIX_LENGTH)}`;
}

// Several mounts of the same app can report concurrently (the old scaffold_app
// card and the new edit_app card both render the head version), so reports
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
): boolean {
  // A known version at or below the last drained one is stale (its render was
  // already reported); unknown (null) versions keep their existing semantics.
  const lastDrained = lastDrainedVersionByApp.get(appId);
  if (lastDrained !== undefined && version !== null && version <= lastDrained) {
    return false;
  }
  let current = diagnosticsByApp.get(appId);
  if (current && versionRank(version) < versionRank(current.version)) {
    return false;
  }
  if (!current || versionRank(version) > versionRank(current.version)) {
    current = { appId, version, entries: [] };
    diagnosticsByApp.set(appId, current);
  }
  if (current.entries.length >= MAX_DIAGNOSTICS_PER_APP) return false;
  const key = dedupKey(entry);
  if (current.entries.some((e) => dedupKey(e) === key)) return false;
  current.entries.push(entry);
  emit();
  return true;
}

/** Drop everything (conversation switch / chat mount). */
export function clearAllAppDiagnostics(): void {
  if (diagnosticsByApp.size === 0 && lastDrainedVersionByApp.size === 0) return;
  diagnosticsByApp.clear();
  lastDrainedVersionByApp.clear();
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
  for (const d of diagnosticsByApp.values()) {
    if (d.version === null) continue;
    const prev = lastDrainedVersionByApp.get(d.appId);
    if (prev === undefined || d.version > prev) {
      lastDrainedVersionByApp.set(d.appId, d.version);
    }
  }
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

export function getAppDiagnosticCounts(): ReadonlyMap<
  string,
  AppDiagnosticCounts
> {
  return countsSnapshot;
}

/** The diagnostics collected for one app at its latest reported version. */
export function getAppDiagnostics(appId: string): AppDiagnostics | null {
  return diagnosticsByApp.get(appId) ?? null;
}
