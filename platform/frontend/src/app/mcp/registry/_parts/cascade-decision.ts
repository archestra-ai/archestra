/**
 * Pure cascade-decision logic for the catalog edit form. Mirrors the
 * backend gate in `backend/src/services/mcp-reinstall.ts` and the PUT
 * route's rename branch + gate sequence around
 * `cascadeReinstallForCatalog`.
 *
 * Decision tree (must match backend exactly):
 *   1. No installs to affect → "skip"
 *   2. Any field requires user re-prompt → "manual"
 *      (covers: runtime config, prompted env schema breaks,
 *       required userConfig changes, OAuth added/removed —
 *       NOT the name: a rename is a pure DB cascade)
 *   3. Only forward-compatible env/userConfig changes (or pure
 *      metadata) → "skip" — unless the name changed: a rename alone →
 *      "rename" (tools re-slug in place, no pod restarts), upgraded to
 *      "manual" when the catalog's deploymentSpecYaml references the
 *      serverName placeholder (the one way the display name reaches a
 *      pod spec, so those installs genuinely need a reinstall).
 *   4. Otherwise → "auto" (breaking change with no re-prompt needed)
 *
 * `renamed` rides along with the mode so the confirm bar can append the
 * MCP-client tool-list reload warning even when a rename composes with
 * a breaking change (modes 2 and 4).
 *
 * If this diverges from the backend gate, the scenario matrix's
 * frontend + backend sweeps will disagree. That's the contract — fix
 * either the code or the scenario, not the test.
 */

import { SERVER_NAME_PLACEHOLDER } from "@archestra/shared";

export type CascadeOutcome = "skip" | "manual" | "auto" | "rename";

export type CascadeDecision = {
  mode: CascadeOutcome;
  /** The catalog name changed — tools will be renamed in place and
   *  connected MCP clients must reload their tool list. */
  renamed: boolean;
};

/**
 * Subset of the catalog item shape that the decision actually inspects.
 * Loosely typed so callers can pass either DB rows or form-derived
 * snapshots without coercion gymnastics.
 */
export type CascadeSnapshot = {
  name?: string;
  description?: string | null;
  serverType?: "local" | "remote" | "builtin";
  serverUrl?: string | null;
  authMethod?: string;
  authHeaderName?: string;
  includeBearerPrefix?: boolean;
  oauthConfig?: unknown;
  enterpriseManagedConfig?: unknown;
  multitenant?: boolean;
  icon?: string | null;
  /** Not editable through the form (separate YAML dialog), so `prev`'s
   *  value is authoritative for the rename placeholder check. */
  deploymentSpecYaml?: string | null;
  localConfig?: {
    command?: string;
    arguments?: string[];
    environment?: PromptedOrStaticEnvVar[];
    envFrom?: unknown[];
    dockerImage?: string;
    transportType?: string;
    httpPort?: number;
    httpPath?: string;
    serviceAccount?: string;
    imagePullSecrets?: unknown[];
  } | null;
  userConfig?: Record<string, unknown> | null;
  labels?: Array<{ key: string; value: string }>;
};

type PromptedOrStaticEnvVar = {
  key?: string;
  type?: string;
  value?: unknown;
  promptOnInstallation?: boolean;
  required?: boolean;
  sensitive?: boolean;
  description?: string;
  // Runtime layout flag — env var (false) vs mounted secret file at
  // `/secrets/<key>` (true). Flipping it requires a pod restart.
  mounted?: boolean;
};

export type ComputeCascadeOutcomeOptions = {
  /** Number of installs the backend cascade would touch. When 0, no
   *  cascade is possible regardless of what changed → always "skip". */
  affectedServerCount: number;
};

/**
 * Decide what the cascade-confirm bar should do for an edit. The form
 * uses the returned mode to either:
 *   • "skip"   — perform the save directly, no bar
 *   • "manual" — fire the bar in manual mode ("Save change")
 *   • "auto"   — fire the bar in auto mode ("Save and restart")
 *   • "rename" — fire the bar in rename mode ("Save and rename"):
 *                pure DB cascade, client-reload warning, no restarts
 */
export function computeCascadeOutcome(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
  { affectedServerCount }: ComputeCascadeOutcomeOptions,
): CascadeDecision {
  // Hoisted above the serverType branches: remote catalogs rename their
  // tools through the same DB cascade as local ones.
  const renamed = (prev.name ?? "") !== (next.name ?? "");

  if (affectedServerCount === 0) return { mode: "skip", renamed };

  // ── Manual ───────────────────────────────────────────────────────
  // Mirror of backend `requiresNewUserInputForReinstall`. Any field
  // here invalidates existing installs in a way the user must
  // explicitly re-confirm at install time (re-prompt for value,
  // re-issue secrets, etc.).
  if (requiresUserReprompt(prev, next)) return { mode: "manual", renamed };

  // ── Skip / rename via forward-compat ─────────────────────────────
  // Mirror of backend `onlyForwardCompatibleEnvDiff`. After the manual
  // checks pass, the remaining diffs may be entirely forward-
  // compatible (added-optional, demoted required → optional, pure
  // metadata, or truly nothing) — a name change is then the only thing
  // left to act on.
  if (onlyForwardCompatibleDiff(prev, next)) {
    if (!renamed) return { mode: "skip", renamed };
    // Mirror of the backend's `flagReinstallRequired`: the serverName
    // placeholder is the one way the display name reaches a pod spec.
    const serverType = next.serverType ?? prev.serverType;
    const renameNeedsReinstall =
      serverType === "local" &&
      Boolean(
        (next.deploymentSpecYaml ?? prev.deploymentSpecYaml)?.includes(
          SERVER_NAME_PLACEHOLDER,
        ),
      );
    return { mode: renameNeedsReinstall ? "manual" : "rename", renamed };
  }

  // ── Auto ─────────────────────────────────────────────────────────
  // A breaking diff exists but doesn't need a user re-prompt. The
  // backend will fire its setImmediate background restart (which also
  // regenerates a placeholder-bearing YAML with the new name, so a
  // combined rename needs no extra flag here).
  return { mode: "auto", renamed };
}

// Manual-path predicate. Mirror of `requiresNewUserInputForReinstall`.

function requiresUserReprompt(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  const serverType = next.serverType ?? prev.serverType;

  if (serverType === "local") {
    // Name changes are handled by the rename mode, not here — deployment
    // identity is frozen and secret names are id-keyed, so a rename needs
    // no re-prompt.
    // 1. localExecutionConfigChanged
    if (localExecutionConfigChanged(prev, next)) return true;
    // 2. promptedEnvVarsChanged (schema evolution on prompted env vars)
    if (promptedEnvVarsChanged(prev, next)) return true;
    // 3. requiredUserConfigChanged (required field added/removed/type)
    if (requiredUserConfigChanged(prev, next)) return true;
    return false;
  }

  if (serverType === "remote") {
    // OAuth added/removed flips the auth model entirely.
    const hadOAuth = Boolean(prev.oauthConfig);
    const hasOAuth = Boolean(next.oauthConfig);
    if (hadOAuth !== hasOAuth) return true;
    if (requiredUserConfigChanged(prev, next)) return true;
    return false;
  }

  return false;
}

function localExecutionConfigChanged(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  const shape = (s: CascadeSnapshot) => ({
    command: s.localConfig?.command ?? "",
    arguments: s.localConfig?.arguments ?? [],
    dockerImage: s.localConfig?.dockerImage ?? "",
    transportType: s.localConfig?.transportType,
    httpPort: s.localConfig?.httpPort,
    httpPath: s.localConfig?.httpPath ?? "",
    serviceAccount: s.localConfig?.serviceAccount ?? "",
  });
  return JSON.stringify(shape(prev)) !== JSON.stringify(shape(next));
}

// Schema-evolution predicates. Mirror of backend/src/services/mcp-reinstall.ts.

type PromptedInfo = {
  required: boolean;
  type: string;
  // `mounted` flips the pod spec between an env var (`mounted=false`)
  // and a mounted secret file at `/secrets/<key>` (`mounted=true`).
  // The schema-evolution check (`promptedEnvVarsChanged`) ignores it
  // because flipping mounted doesn't need re-prompt, but the auto
  // path's whole-row diff still has to catch it — see
  // `onlyForwardCompatibleDiff`'s `promptedEnvVarsRuntimeChanged` hop.
  mounted: boolean;
};

const promptedEnvMap = (
  arr: PromptedOrStaticEnvVar[] | undefined,
): Map<string, PromptedInfo> => {
  const m = new Map<string, PromptedInfo>();
  for (const v of arr ?? []) {
    if (!v?.key || !v.promptOnInstallation) continue;
    m.set(v.key, {
      required: Boolean(v.required),
      type: String(v.type ?? ""),
      mounted: Boolean(v.mounted),
    });
  }
  return m;
};

/**
 * Mirror of backend `promptedEnvVarsChanged`. True when the
 * prompted-env schema changed in a way that invalidates installs (added required,
 * removed, type change, required false → true).
 */
export function promptedEnvVarsChanged(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  const prevMap = promptedEnvMap(prev.localConfig?.environment);
  const nextMap = promptedEnvMap(next.localConfig?.environment);
  for (const [key, p] of prevMap) {
    const n = nextMap.get(key);
    if (!n) return true;
    if (n.type !== p.type) return true;
    if (!p.required && n.required) return true;
  }
  for (const [key, n] of nextMap) {
    if (prevMap.has(key)) continue;
    if (n.required) return true;
  }
  return false;
}

/**
 * Mirror of backend `promptedEnvVarsRuntimeChanged`. True when a
 * prompted env var present on both sides has a different `mounted` flag. Drives
 * the auto path (pod restart) without manual re-prompt.
 */
function promptedEnvVarsRuntimeChanged(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  const prevMap = promptedEnvMap(prev.localConfig?.environment);
  const nextMap = promptedEnvMap(next.localConfig?.environment);
  for (const [key, p] of prevMap) {
    const n = nextMap.get(key);
    if (!n) continue; // Removal is handled by promptedEnvVarsChanged
    if (p.mounted !== n.mounted) return true;
  }
  return false;
}

/**
 * Mirror of backend `requiredUserConfigChanged`. True when a change to
 * the required-userConfig-fields set needs a user re-prompt:
 *   • added required field (install must supply a new value), OR
 *   • type changed on a still-required field (storage moves).
 *
 * Removals from the required set are NOT breaking here — that case is
 * either a demotion (required true → false: existing values still valid)
 * or a full field deletion (caught by `userConfigChangedBreakingly`,
 * which routes to the auto path; pod restart drops the orphaned value
 * without re-prompting the user).
 */
export function requiredUserConfigChanged(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  const required = (cfg: Record<string, unknown> | null | undefined) => {
    const m = new Map<string, { type: string }>();
    for (const [k, raw] of Object.entries(cfg ?? {})) {
      const r = raw as Record<string, unknown>;
      if (r?.required) m.set(k, { type: String(r.type ?? "") });
    }
    return m;
  };
  const prevReq = required(prev.userConfig);
  const nextReq = required(next.userConfig);
  for (const [k, p] of prevReq) {
    const n = nextReq.get(k);
    if (!n) continue; // Removed from required set — see comment above
    if (n.type !== p.type) return true; // Type changed on still-required field
  }
  for (const k of nextReq.keys()) {
    if (!prevReq.has(k)) return true; // Added required → install must supply
  }
  return false;
}

// Forward-compatible diff predicates. Mirror of backend `onlyForwardCompatibleEnvDiff`.

function onlyForwardCompatibleDiff(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  // Prompted env-var changes are schema-evolution compatible.
  if (promptedEnvVarsChanged(prev, next)) return false;
  // …but a runtime-only `mounted` flip still requires a pod restart
  // (env var ↔ mounted secret file). Routes through the auto path,
  // not the manual one.
  if (promptedEnvVarsRuntimeChanged(prev, next)) return false;

  // Non-prompted env vars are unchanged.
  const stripPromptOnInstall = (arr: PromptedOrStaticEnvVar[] | undefined) =>
    (arr ?? []).filter((e) => e?.key && !e.promptOnInstallation);
  if (
    JSON.stringify(stripPromptOnInstall(prev.localConfig?.environment)) !==
    JSON.stringify(stripPromptOnInstall(next.localConfig?.environment))
  ) {
    return false;
  }

  // userConfig schema evolution.
  if (userConfigChangedBreakingly(prev.userConfig, next.userConfig)) {
    return false;
  }

  // Nothing else (beyond metadata) differs.
  return !anyNonForwardCompatChange(prev, next);
}

/**
 * Mirror of backend `userConfigChangedBreakingly`. True when a
 * userConfig field change invalidates existing installs (added required,
 * removed any, type/headerName/sensitive flip, required false → true, or
 * a static header-mapped field's `default` value changes). For prompted
 * fields, `default` is just a placeholder shown at install time, so
 * changes there stay non-breaking.
 */
export function userConfigChangedBreakingly(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  const prevMap = (prev ?? {}) as Record<string, Record<string, unknown>>;
  const nextMap = (next ?? {}) as Record<string, Record<string, unknown>>;

  for (const [key, p] of Object.entries(prevMap)) {
    const n = nextMap[key];
    if (!n) return true;
    if (!p.required && Boolean(n.required)) return true;
    if (String(p.type ?? "") !== String(n.type ?? "")) return true;
    if (String(p.headerName ?? "") !== String(n.headerName ?? "")) return true;
    if (Boolean(p.sensitive) !== Boolean(n.sensitive)) return true;
    // Static header value rotation — `default` is the runtime header
    // value for static header-mapped entries (the form writes the admin's
    // input straight into `default` when promptOnInstallation is false).
    if (
      String(p.headerName ?? "") !== "" &&
      !p.promptOnInstallation &&
      !n.promptOnInstallation &&
      String(p.default ?? "") !== String(n.default ?? "")
    ) {
      return true;
    }
  }
  for (const [key, n] of Object.entries(nextMap)) {
    if (key in prevMap) continue;
    if (n.required) return true;
  }
  return false;
}

function anyNonForwardCompatChange(
  prev: CascadeSnapshot,
  next: CascadeSnapshot,
): boolean {
  // Project to the fields whose change is non-forward-compatible but
  // doesn't need user re-prompt (the "auto"-path triggers). Re-prompt
  // fields (name, command, etc.) and schema-evolution fields (env,
  // userConfig) are classified by the predicates above and intentionally
  // omitted here.
  //
  // Explicit projection — NOT a strip-then-stringify — because `prev`
  // comes from the API (extra fields: id, organizationId, createdAt,
  // updatedAt, repository, version, ...) while `next` is built fresh by
  // `transformFormToApiData` (smaller field set). A stringify of the
  // whole object would flag every edit as a diff because of the extra
  // API-only keys on the prev side.
  //
  // METADATA_ONLY_CATALOG_FIELDS are intentionally excluded so they
  // never trigger cascade — that's their contract.
  const project = (cat: CascadeSnapshot) =>
    JSON.stringify({
      serverType: cat.serverType ?? "",
      serverUrl: cat.serverUrl ?? "",
      authMethod: cat.authMethod ?? "",
      authHeaderName: cat.authHeaderName ?? "",
      includeBearerPrefix: Boolean(cat.includeBearerPrefix),
      oauthConfig: cat.oauthConfig ?? null,
      enterpriseManagedConfig: cat.enterpriseManagedConfig ?? null,
      multitenant: Boolean(cat.multitenant),
      envFrom: cat.localConfig?.envFrom ?? null,
      imagePullSecrets: cat.localConfig?.imagePullSecrets ?? null,
    });
  return project(prev) !== project(next);
}
