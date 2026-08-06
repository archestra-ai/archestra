import type { UseFormReturn } from "react-hook-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  applyImportedServerToForm,
  type ImportedMcpServer,
} from "./mcp-config-import";

/** The `mcpServers` wrapper key — same derivation as the serializer. */
export function connectionServerKey(values: McpCatalogFormValues): string {
  return values.name?.trim() || "server";
}

/** Render gate for the Authentication section — single source, also drives
 * the import dialog's consequence lines. */
export function authSectionApplies(
  values: Pick<McpCatalogFormValues, "serverType" | "multitenant">,
): boolean {
  return (
    values.serverType === "remote" ||
    (values.serverType === "local" && Boolean(values.multitenant))
  );
}

/** Render gate for the Headers section — single source, also drives the
 * import dialog's consequence lines. */
export function headersSectionApplies(
  values: Pick<McpCatalogFormValues, "serverType"> & {
    localConfig?: { transportType?: string } | null;
  },
): boolean {
  return (
    values.serverType === "remote" ||
    (values.serverType === "local" &&
      values.localConfig?.transportType === "streamable-http")
  );
}

export interface ApplyChangeLine {
  label: string;
  detail: string;
}

export type ApplyPlan =
  | { applied: false; reason: string }
  | {
      applied: true;
      /** Group-level change lines, one per touched field group. */
      changes: ApplyChangeLine[];
      /** One templated preservation line, or null when nothing to state. */
      kept: string | null;
      /** Section-gating consequences of this apply. */
      gating: string[];
      /** Exact form paths the apply mutates — drives the scoped Undo. */
      touchedPaths: string[];
    };

/**
 * Predicts exactly what applying `server` to a form holding `current` will
 * do — by running the REAL `applyImportedServerToForm` against a shadow copy
 * and diffing. Zero duplicated merge logic, so the preview can never drift
 * from the hardened apply semantics.
 */
export function computeApplyChanges(params: {
  current: McpCatalogFormValues;
  server: ImportedMcpServer;
  allowServerTypeChange: boolean;
  /** See applyImportedServerToForm — passed through to the shadow apply. */
  transportConfigured: boolean;
}): ApplyPlan {
  const { current, server, allowServerTypeChange, transportConfigured } =
    params;
  const shadow = structuredClone(current) as unknown as Record<string, unknown>;
  const shadowForm = {
    getValues: (path?: string) =>
      path === undefined ? shadow : getAtPath(shadow, path),
    // setValue drops the options argument ({ shouldDirty }) on purpose —
    // dirty tracking has no meaning on a throwaway shadow object.
    setValue: (path: string, value: unknown) => setAtPath(shadow, path, value),
  } as unknown as UseFormReturn<McpCatalogFormValues>;

  const outcome = applyImportedServerToForm({
    form: shadowForm,
    server,
    allowServerTypeChange,
    transportConfigured,
  });
  if (!outcome.applied) {
    return outcome;
  }

  const next = shadow as unknown as McpCatalogFormValues;
  const touchedPaths = APPLY_CANDIDATE_PATHS.filter(
    (path) => !plainEqual(getAtPath(current, path), getAtPath(shadow, path)),
  );
  const touched = new Set<string>(touchedPaths);

  const changes: ApplyChangeLine[] = [];
  if (touched.has("serverType")) {
    changes.push({
      label: "Server Type",
      detail: `switches to ${serverTypeLabel(next.serverType)}`,
    });
  }
  if (touched.has("serverUrl")) {
    changes.push({
      label: "Server URL",
      detail: describeScalarChange(current.serverUrl, next.serverUrl),
    });
  }
  if (touched.has("localConfig.command")) {
    changes.push({
      label: "Command",
      detail: describeScalarChange(
        current.localConfig?.command,
        next.localConfig?.command,
      ),
    });
  }
  if (touched.has("localConfig.arguments")) {
    changes.push({
      label: "Arguments",
      detail: describeScalarChange(
        singleLine(current.localConfig?.arguments),
        singleLine(next.localConfig?.arguments),
      ),
    });
  }
  if (touched.has("localConfig.transportType")) {
    changes.push({
      label: "Transport",
      detail: describeScalarChange(
        current.localConfig?.transportType,
        next.localConfig?.transportType,
      ),
    });
  }
  if (touched.has("localConfig.httpPort")) {
    changes.push({
      label: "HTTP port",
      detail: describeScalarChange(
        current.localConfig?.httpPort,
        next.localConfig?.httpPort,
      ),
    });
  }
  if (touched.has("localConfig.httpPath")) {
    changes.push({
      label: "HTTP path",
      detail: describeScalarChange(
        current.localConfig?.httpPath,
        next.localConfig?.httpPath,
      ),
    });
  }
  if (touched.has("localConfig.dockerImage")) {
    changes.push({
      label: "Docker image",
      detail: describeScalarChange(
        current.localConfig?.dockerImage,
        next.localConfig?.dockerImage,
      ),
    });
  }
  if (touched.has("localConfig.environment")) {
    changes.push({
      label: "Environment variables",
      detail: describeRowSetChange(
        (current.localConfig?.environment ?? []).map((env) => ({
          id: env.key,
          row: env,
          stored: env.type === "secret",
        })),
        (next.localConfig?.environment ?? []).map((env) => ({
          id: env.key,
          row: env,
          stored: env.type === "secret",
        })),
        "stored secrets kept where masked",
      ),
    });
  }
  if (touched.has("additionalHeaders")) {
    changes.push({
      label: "Headers",
      detail: describeRowSetChange(
        (current.additionalHeaders ?? []).map((header) => ({
          id: header.headerName.toLowerCase(),
          row: header,
          stored: header.promptOnInstallation === true,
        })),
        (next.additionalHeaders ?? []).map((header) => ({
          id: header.headerName.toLowerCase(),
          row: header,
          stored: header.promptOnInstallation === true,
        })),
        "merged with the stored row",
      ),
    });
  }
  if (touched.has("authMethod")) {
    changes.push({
      label: "Authentication",
      detail: `${authMethodLabel(next.authMethod)} (from the pasted headers)`,
    });
  }
  if (touched.has("name")) {
    changes.push({ label: "Name", detail: `fills "${next.name}"` });
  }
  if (touched.has("description")) {
    changes.push({ label: "Description", detail: "fills from the config" });
  }

  return {
    applied: true,
    changes,
    kept: describeKeptConfig(current, touched),
    gating: describeGatingDeltas(current, next),
    touchedPaths,
  };
}

/**
 * Path-scoped Undo for a dialog Apply: restores ONLY the paths the apply
 * touched to their snapshot values. Later edits to untouched fields survive
 * by construction — no dismissal heuristics needed.
 */
export function revertApplyChanges(params: {
  form: UseFormReturn<McpCatalogFormValues>;
  snapshot: McpCatalogFormValues;
  touchedPaths: string[];
}): void {
  const { form, snapshot, touchedPaths } = params;
  for (const path of touchedPaths) {
    form.setValue(
      path as Parameters<typeof form.setValue>[0],
      getAtPath(snapshot, path) as never,
      { shouldDirty: true },
    );
  }
}

// =========================================================================
// Internal helpers
// =========================================================================

/** Every path `applyImportedServerToForm` can possibly set. */
const APPLY_CANDIDATE_PATHS = [
  "serverType",
  "serverUrl",
  "authMethod",
  "includeBearerPrefix",
  "authHeaderName",
  "additionalHeaders",
  "localConfig.command",
  "localConfig.arguments",
  "localConfig.environment",
  "localConfig.dockerImage",
  "localConfig.transportType",
  "localConfig.httpPort",
  "localConfig.httpPath",
  "name",
  "description",
];

function getAtPath(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (acc: unknown, key) =>
        acc == null ? undefined : (acc as Record<string, unknown>)[key],
      source,
    );
}

function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
}

function plainEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function serverTypeLabel(
  serverType: McpCatalogFormValues["serverType"],
): string {
  return serverType === "local" ? "Self-hosted" : "Remote";
}

function authMethodLabel(
  authMethod: McpCatalogFormValues["authMethod"],
): string {
  switch (authMethod) {
    case "auth_header":
      return "Token header";
    case "bearer":
      return "Bearer token";
    case "oauth":
      return "OAuth 2.1";
    case "oauth_client_credentials":
      return "OAuth client credentials";
    case "enterprise_managed":
      return "IdP token exchange";
    case "idp_jwt":
      return "IdP signed JWT";
    default:
      return "None";
  }
}

function singleLine(value: string | undefined): string | undefined {
  return value?.replaceAll("\n", " ");
}

function truncate(value: string): string {
  return value.length > 48 ? `${value.slice(0, 45)}…` : value;
}

/** Never called for secret values — scalar connection fields only. */
function describeScalarChange(
  from: string | undefined,
  to: string | undefined,
): string {
  const fromTrimmed = from?.trim() ?? "";
  const toTrimmed = to?.trim() ?? "";
  if (!fromTrimmed) return `set to ${truncate(toTrimmed)}`;
  if (!toTrimmed) return "cleared";
  return `${truncate(fromTrimmed)} → ${truncate(toTrimmed)}`;
}

/**
 * Group summary for a keyed row set (env vars, headers): added / replaced /
 * removed / unchanged counts, with a semantic clause instead of value arrows
 * when stored secret rows survive a masked re-paste.
 */
function describeRowSetChange(
  current: Array<{ id: string; row: unknown; stored: boolean }>,
  next: Array<{ id: string; row: unknown; stored: boolean }>,
  keptClause: string,
): string {
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const nextById = new Map(next.map((entry) => [entry.id, entry]));
  let added = 0;
  let replaced = 0;
  let removed = 0;
  let unchanged = 0;
  let storedKept = 0;
  for (const [id, entry] of nextById) {
    const existing = currentById.get(id);
    if (!existing) {
      added += 1;
    } else if (plainEqual(existing.row, entry.row)) {
      unchanged += 1;
      if (existing.stored) storedKept += 1;
    } else {
      replaced += 1;
    }
  }
  for (const id of currentById.keys()) {
    if (!nextById.has(id)) removed += 1;
  }
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (replaced) parts.push(`${replaced} replaced`);
  if (removed) parts.push(`${removed} removed`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (storedKept) parts.push(keptClause);
  return parts.join(" · ");
}

/**
 * The one preservation line: config an import never touches, listed so
 * "not in the changes" is never the only signal that something survived.
 */
function describeKeptConfig(
  current: McpCatalogFormValues,
  touched: Set<string>,
): string | null {
  const parts: string[] = [];
  const formOnlyAuth =
    current.authMethod !== "none" &&
    current.authMethod !== "auth_header" &&
    current.authMethod !== "bearer";
  if (formOnlyAuth && !touched.has("authMethod")) {
    parts.push(`${authMethodLabel(current.authMethod)} setup`);
  }
  const envFromCount = current.localConfig?.envFrom?.length ?? 0;
  if (envFromCount > 0) {
    parts.push(`${envFromCount} env source${envFromCount === 1 ? "" : "s"}`);
  }
  const mountedCount = (current.localConfig?.environment ?? []).filter(
    (env) => env.mounted,
  ).length;
  if (mountedCount > 0) {
    parts.push(`${mountedCount} secret file${mountedCount === 1 ? "" : "s"}`);
  }
  const pullSecretCount = current.localConfig?.imagePullSecrets?.length ?? 0;
  if (pullSecretCount > 0) {
    parts.push(
      `${pullSecretCount} image pull secret${pullSecretCount === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0
    ? `Kept, outside the JSON: ${parts.join(" · ")}`
    : null;
}

/** Section-gating consequences, from the same predicates that gate render. */
function describeGatingDeltas(
  current: McpCatalogFormValues,
  next: McpCatalogFormValues,
): string[] {
  const lines: string[] = [];
  const authBefore = authSectionApplies(current);
  const authAfter = authSectionApplies(next);
  if (!authBefore && authAfter) {
    lines.push(
      next.authMethod === "none"
        ? "Authentication will apply below — it defaults to None."
        : `Authentication will apply below — ${authMethodLabel(next.authMethod)}.`,
    );
  } else if (authBefore && !authAfter && next.authMethod !== "none") {
    lines.push(
      `Authentication (${authMethodLabel(next.authMethod)}) is kept but won't apply to a self-hosted single-tenant server.`,
    );
  }
  const headersBefore = headersSectionApplies(current);
  const headersAfter = headersSectionApplies(next);
  const headerCount = next.additionalHeaders?.length ?? 0;
  if (!headersBefore && headersAfter) {
    lines.push("Headers will apply below.");
  } else if (headersBefore && !headersAfter && headerCount > 0) {
    lines.push(
      `${headerCount} configured header${headerCount === 1 ? "" : "s"} ${headerCount === 1 ? "is" : "are"} kept but won't be sent over stdio transport.`,
    );
  }
  return lines;
}
