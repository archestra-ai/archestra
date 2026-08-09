/**
 * Redaction for the MCP catalog config surfaces that carry credentials.
 *
 * Secret values belong in the catalog's secret bag, never in a jsonb column, a
 * tool result, or a tool-call log. Extraction (backend-side) is what moves them
 * there; these helpers are the display/logging counterpart, so a value that
 * escapes extraction still cannot reach a caller or a log row.
 *
 * Pure and dependency-free so both the backend model layer and the tool
 * handlers can use them. Every function returns a redacted copy and never
 * mutates its input — callers keep the plaintext original (the MCP gateway
 * builds its JSON-RPC response from it).
 */

export const REDACTED_PLACEHOLDER = "[redacted]";

/** Catalog `localConfig`: secret-typed env values and registry passwords. */
export function redactLocalConfigSecrets<T>(localConfig: T): T {
  if (!isRecord(localConfig) || !localConfigHasSecret(localConfig)) {
    return localConfig;
  }
  const copy: UnknownRecord = structuredClone(localConfig);
  redactLocalConfigInPlace(copy);
  return copy as T;
}

/**
 * Arguments of an MCP tool call, before they are written to the tool-call log.
 * The catalog tools take `environment`, `imagePullSecrets` and `oauthConfig` as
 * top-level arguments, so those are the paths checked. Matching is shape-driven
 * rather than key-name-driven, which leaves ordinary arguments — including ones
 * incidentally named `value` or `password` — searchable in the logs.
 */
export function redactCatalogToolArguments<T>(args: T, depth = 0): T {
  if (!isRecord(args)) return args;

  // `run_tool` envelopes the target tool's arguments under `tool_args`, so an
  // agent in search_and_run_only mode carries the credential one level down.
  // Bounded rather than fully recursive: the envelope is shallow by
  // construction, and untrusted input decides the nesting.
  const nested = args.tool_args;
  const redactedNested =
    depth < MAX_ENVELOPE_DEPTH && isRecord(nested)
      ? redactCatalogToolArguments(nested, depth + 1)
      : nested;
  const nestedChanged = redactedNested !== nested;

  const oauthConfig = args.oauthConfig;
  const oauthNeedsRedaction =
    isRecord(oauthConfig) && oauthConfig.client_secret !== undefined;
  if (!localConfigHasSecret(args) && !oauthNeedsRedaction && !nestedChanged) {
    return args;
  }

  const copy: UnknownRecord = structuredClone(args);
  redactLocalConfigInPlace(copy);
  if (isRecord(copy.oauthConfig)) {
    copy.oauthConfig.client_secret = REDACTED_PLACEHOLDER;
  }
  if (nestedChanged) copy.tool_args = redactedNested;
  return copy as T;
}

// === Internal ===

type UnknownRecord = Record<string, unknown>;

const MAX_ENVELOPE_DEPTH = 3;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `environment` or `imagePullSecrets` carry a value worth removing.
 * Checked before cloning so calls that carry nothing sensitive — the vast
 * majority of tool calls — return the original object untouched.
 */
function localConfigHasSecret(container: UnknownRecord): boolean {
  const environment = container.environment;
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (
        isRecord(entry) &&
        entry.type === "secret" &&
        entry.value !== undefined
      ) {
        return true;
      }
    }
  }

  const imagePullSecrets = container.imagePullSecrets;
  if (Array.isArray(imagePullSecrets)) {
    for (const entry of imagePullSecrets) {
      if (isRecord(entry) && entry.password !== undefined) return true;
    }
  }

  return false;
}

function redactLocalConfigInPlace(container: UnknownRecord): void {
  const environment = container.environment;
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (
        isRecord(entry) &&
        entry.type === "secret" &&
        entry.value !== undefined
      ) {
        entry.value = REDACTED_PLACEHOLDER;
      }
    }
  }

  const imagePullSecrets = container.imagePullSecrets;
  if (Array.isArray(imagePullSecrets)) {
    for (const entry of imagePullSecrets) {
      if (isRecord(entry) && entry.password !== undefined) {
        entry.password = REDACTED_PLACEHOLDER;
      }
    }
  }
}
