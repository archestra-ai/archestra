import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  getCreationDefaultArchestraToolShortNames,
  isPlaywrightCatalogItem,
  parseFullToolName,
} from "@archestra/shared";
import { DYNAMIC_CREDENTIAL_VALUE } from "./token-select";

type BulkToolUpdateBody = NonNullable<
  archestraApiTypes.BulkUpdateAgentToolsData["body"]
>;
// Both default to `[]` server-side, so the generated body types them optional.
// This builder always returns an array — an empty one means "nothing to send".
type BulkToolAssignments = NonNullable<BulkToolUpdateBody["assignments"]>;
type BulkToolRemovals = NonNullable<BulkToolUpdateBody["removals"]>;

/** The parts of one catalog's pending edits a bulk save reads. */
type PendingCatalogChangesInput = {
  selectedToolIds: Set<string>;
  credentialSourceId: string | null;
  catalogItem: {
    id: string;
    serverType?: string | null;
    enterpriseManagedConfig?: unknown;
  };
};

/** The parts of an already-saved assignment a bulk save reads. */
type AssignedToolInput = {
  tool: { id: string };
  mcpServerId: string | null;
  credentialResolutionMode: "static" | "dynamic" | "enterprise_managed";
};

/**
 * The credential pick a catalog's saved assignments stand for. The editor
 * offers ONE pick per catalog and seeds it from the first saved row: a static
 * pin shows its server; everything else — dynamic, enterprise-managed, or a
 * static assignment whose pinned server is gone (the shape every built-in tool
 * is stored in) — shows as resolve-at-call-time, which is also how the
 * backend routes it.
 */
export function credentialSourceOfAssignments(
  assigned: readonly AssignedToolInput[],
): string {
  const first = assigned[0];
  return first?.credentialResolutionMode === "static"
    ? (first.mcpServerId ?? DYNAMIC_CREDENTIAL_VALUE)
    : DYNAMIC_CREDENTIAL_VALUE;
}

/**
 * Fold every catalog's pending edits into ONE assignments/removals pair.
 *
 * Sending them per tool (the shape this replaced) forked an agent config version
 * per request, so adding a 30-tool server burned 30 of the 100 retained versions
 * and an add-then-remove cycle evicted the edits a human made.
 */
export function buildBulkToolUpdate(params: {
  targetAgentId: string;
  pendingChanges: Iterable<readonly [string, PendingCatalogChangesInput]>;
  assignedToolsByCatalog: Map<string, AssignedToolInput[]>;
  /**
   * True while creating: `AgentModel.create` already assigned the creation
   * defaults, but the assigned-tools query still reflects the pre-create state.
   */
  isNewAgent: boolean;
  creationDefaultToolIds?: Iterable<string>;
}): {
  assignments: BulkToolAssignments;
  removals: BulkToolRemovals;
  hasChanges: boolean;
} {
  const { targetAgentId, assignedToolsByCatalog, isNewAgent } = params;
  const assignments: BulkToolAssignments = [];
  const removals: BulkToolRemovals = [];
  let hasChanges = false;

  for (const [catalogId, changes] of params.pendingChanges) {
    const currentAssigned = assignedToolsByCatalog.get(catalogId) ?? [];
    const currentAssignedIds = new Set(currentAssigned.map((at) => at.tool.id));
    // Diff the built-in catalog against the defaults the backend just assigned,
    // so unchecking a pre-selected default produces a real unassign and a
    // default left checked is not redundantly re-assigned.
    if (isNewAgent && catalogId === ARCHESTRA_MCP_CATALOG_ID) {
      for (const id of params.creationDefaultToolIds ?? []) {
        currentAssignedIds.add(id);
      }
    }

    const toAdd = [...changes.selectedToolIds].filter(
      (id) => !currentAssignedIds.has(id),
    );
    const toRemove = [...currentAssignedIds].filter(
      (id) => !changes.selectedToolIds.has(id),
    );

    if (toAdd.length > 0 || toRemove.length > 0) {
      hasChanges = true;
    }

    const prefersEnterpriseManaged =
      changes.catalogItem.enterpriseManagedConfig != null;

    // Apps resolve their launch tool in-process per viewer, so they bind
    // dynamically like Playwright — there is no credential to pick.
    const useDynamicCredential =
      isPlaywrightCatalogItem(changes.catalogItem.id) ||
      changes.catalogItem.serverType === "app" ||
      changes.credentialSourceId === DYNAMIC_CREDENTIAL_VALUE;
    const useEnterpriseManagedCredential =
      prefersEnterpriseManaged && useDynamicCredential;

    const credentialResolutionMode = useEnterpriseManagedCredential
      ? "enterprise_managed"
      : useDynamicCredential
        ? "dynamic"
        : "static";
    // A late-bound mode resolves the server per call, so any previously pinned
    // server is cleared rather than carried over.
    const mcpServerId =
      !useDynamicCredential && !useEnterpriseManagedCredential
        ? (changes.credentialSourceId ?? null)
        : null;

    for (const toolId of toRemove) {
      removals.push({ agentId: targetAgentId, toolId });
    }
    for (const toolId of toAdd) {
      assignments.push({
        agentId: targetAgentId,
        toolId,
        mcpServerId,
        resolveAtCallTime: useDynamicCredential,
        credentialResolutionMode,
      });
    }

    // Tools that stay assigned are re-bound when the catalog's credential pick
    // changed. Re-assigning is the correct upsert — the bulk write reports
    // these as `updated`. "Changed" is measured against the pick the editor
    // seeded from the saved rows, not row by row: a static assignment with no
    // pinned server is shown (and routed) as resolve-at-call-time, and diffing
    // it against that pick read every pristine built-in tool as an edit.
    const toKeep = currentAssigned.filter((at) =>
      changes.selectedToolIds.has(at.tool.id),
    );
    if (
      toKeep.length > 0 &&
      changes.credentialSourceId !==
        credentialSourceOfAssignments(currentAssigned)
    ) {
      hasChanges = true;
      for (const agentTool of toKeep) {
        assignments.push({
          agentId: targetAgentId,
          toolId: agentTool.tool.id,
          mcpServerId,
          resolveAtCallTime: useDynamicCredential,
          credentialResolutionMode,
        });
      }
    }
  }

  return { assignments, removals, hasChanges };
}

/**
 * The one error the bulk-update response carries, or undefined when the save
 * succeeded.
 *
 * ONLY `failed` is an error. `notAssigned` means the row was already gone (a
 * concurrent edit, or a stale view) and `duplicates` that it already matched —
 * both are benign, and on the create path agent-dialog reacts to a throw by
 * DELETING the agent it just created.
 *
 * The batch spans every catalog, so one save can fail several tools for
 * unrelated reasons. Report the first and count the rest — dropping them
 * silently would have the user fix one problem, re-save, and meet the next.
 */
export function summarizeBulkFailure(
  failed: { error: string }[] | undefined,
): string | undefined {
  const failures = failed ?? [];
  const first = failures[0];
  if (!first) return undefined;
  return failures.length > 1
    ? `${first.error} (and ${failures.length - 1} more)`
    : first.error;
}

/**
 * The IDs of the creation-default Archestra tools within a single catalog's
 * tool list.
 *
 * The default set is composed by the shared
 * `getCreationDefaultArchestraToolShortNames` from the same feature flags
 * `AgentModel.create` reads server-side, so it matches exactly what the
 * backend assigns at agent creation.
 *
 * Returns an empty set when `tools` is empty or nothing matches (e.g. a
 * non-Archestra catalog, whose tool names never carry a default short name).
 */
export function filterDefaultArchestraToolIds(
  tools: { id: string; name: string }[],
  options: {
    skillsEnabled?: boolean;
    sandboxEnabled?: boolean;
  } = {},
): Set<string> {
  const creationDefaultShortNames = new Set<string>(
    getCreationDefaultArchestraToolShortNames({
      skillsEnabled: options.skillsEnabled === true,
      sandboxEnabled: options.sandboxEnabled === true,
    }),
  );

  return new Set(
    tools
      .filter((t) => {
        const shortName = parseFullToolName(t.name).toolName;
        return shortName !== null && creationDefaultShortNames.has(shortName);
      })
      .map((t) => t.id),
  );
}

type EnvScopedCatalog = {
  id: string;
  name: string;
  serverType?: string | null;
  environmentId?: string | null;
};

/**
 * A catalog belongs to an agent's environment when it's a builtin (the
 * Archestra platform tools, available in every environment) or its environment
 * matches. `null`/`undefined` (Default runtime) is its own bucket.
 */
export function isCatalogInEnvironment(
  catalog: EnvScopedCatalog,
  agentEnvironmentId: string | null,
): boolean {
  return (
    catalog.serverType === "builtin" ||
    (catalog.environmentId ?? null) === (agentEnvironmentId ?? null)
  );
}

/**
 * App variant of {@link isCatalogInEnvironment}: apps additionally accept the
 * Default environment (null) as a shared baseline, so a Default catalog is
 * assignable to an app in any environment. Mirrors the backend's
 * toolInEnvironmentOrDefaultPredicate; agents keep the strict helper.
 */
export function isCatalogInAppEnvironment(
  catalog: EnvScopedCatalog,
  appEnvironmentId: string | null,
): boolean {
  return (
    isCatalogInEnvironment(catalog, appEnvironmentId) ||
    (catalog.environmentId ?? null) === null
  );
}

/**
 * Whether a catalog item may be assigned to an agent in the tools picker, and
 * how it should read when it is.
 *
 * A catalog item is assignable when it has at least one **discovered** tool; an
 * install the assigning caller can resolve is NOT required. A discovered tool
 * with no resolvable install stays assignable as a dynamic assignment — its
 * connection resolved per caller at call time — and is surfaced as `unavailable`,
 * prompting install/reconnect when invoked. A catalog item with no discovered
 * tool has nothing to assign. Environment incompatibility is a separate,
 * orthogonal gate.
 */
export function getCatalogAssignmentGate(params: {
  hasDiscoveredTools: boolean;
  hasResolvableInstall: boolean;
  isEnvIncompatible: boolean;
  environmentName?: string | null;
  /** A disabled app backing: listed for its author but not assignable. */
  isDisabledApp?: boolean;
}): { disabled: boolean; disabledReason?: string; unavailable: boolean } {
  const { hasDiscoveredTools, hasResolvableInstall, isEnvIncompatible } =
    params;

  // A disabled app cannot be wired into an agent until it is enabled —
  // surfaced greyed with "Disabled" (only its author ever sees it here).
  if (params.isDisabledApp) {
    return {
      disabled: true,
      unavailable: false,
      disabledReason: "Disabled",
    };
  }

  if (isEnvIncompatible) {
    return {
      disabled: true,
      unavailable: false,
      disabledReason: `Not in ${
        params.environmentName
          ? `the "${params.environmentName}" environment`
          : "the Default environment"
      }`,
    };
  }

  if (!hasDiscoveredTools) {
    return {
      disabled: true,
      unavailable: false,
      disabledReason: "Not installed",
    };
  }

  return { disabled: false, unavailable: !hasResolvableInstall };
}

/**
 * Whether the tools picker should drop a per-server credential pin back to
 * resolve-at-call-time.
 *
 * Only a genuinely stale pin — one absent from a non-empty set of connections
 * that resolve for the caller — is reset. When no connection resolves at all,
 * the pin is preserved: the assignment persists independently of install state,
 * so coercing it here would register a pending change and silently rewrite the
 * pin to dynamic on the next save. A dynamic/unset selection has nothing to
 * reset.
 */
export function shouldResetCredentialPin(params: {
  credentialsLoaded: boolean;
  selectionIsDynamic: boolean;
  pinnedServerId: string | null;
  resolvableServerIds: readonly string[];
}): boolean {
  const { credentialsLoaded, selectionIsDynamic, pinnedServerId } = params;

  if (!credentialsLoaded || selectionIsDynamic || pinnedServerId === null) {
    return false;
  }
  if (params.resolvableServerIds.includes(pinnedServerId)) {
    return false;
  }
  return params.resolvableServerIds.length > 0;
}

/**
 * The selected catalogs that don't belong to the agent's environment (builtins
 * are always compatible). Drives the save-blocking conflict alert. Unknown
 * catalog ids are skipped.
 */
export function computeMcpEnvConflicts(
  catalogItems: EnvScopedCatalog[],
  selectedCatalogIds: Iterable<string>,
  agentEnvironmentId: string | null,
): { catalogId: string; name: string }[] {
  const byId = new Map(catalogItems.map((c) => [c.id, c]));
  const conflicts: { catalogId: string; name: string }[] = [];
  for (const catalogId of selectedCatalogIds) {
    const catalog = byId.get(catalogId);
    if (!catalog || isCatalogInEnvironment(catalog, agentEnvironmentId)) {
      continue;
    }
    conflicts.push({ catalogId, name: catalog.name });
  }
  return conflicts;
}

export function sortCatalogItems<
  T extends { id: string; name: string; serverType?: string | null },
>(
  catalogItems: T[],
  getAssignedCount: (catalog: T) => number,
  getToolCount: (catalog: T) => number,
): T[] {
  return [...catalogItems].sort((a, b) => {
    const aIsBuiltIn = a.id === ARCHESTRA_MCP_CATALOG_ID ? 1 : 0;
    const bIsBuiltIn = b.id === ARCHESTRA_MCP_CATALOG_ID ? 1 : 0;
    if (aIsBuiltIn !== bIsBuiltIn) return bIsBuiltIn - aIsBuiltIn;

    const aAssigned = getAssignedCount(a);
    const bAssigned = getAssignedCount(b);

    if (aAssigned > 0 && bAssigned === 0) return -1;
    if (aAssigned === 0 && bAssigned > 0) return 1;
    if (aAssigned !== bAssigned) return bAssigned - aAssigned;

    const aCount = getToolCount(a);
    const bCount = getToolCount(b);
    if (aCount > 0 && bCount === 0) return -1;
    if (aCount === 0 && bCount > 0) return 1;

    return a.name.localeCompare(b.name);
  });
}

/**
 * Filter tools by search query (matching formatted name or description)
 * and sort with selected tools first.
 */
export function sortAndFilterTools<
  T extends { id: string; name: string; description?: string | null },
>(tools: T[], selectedToolIds: Set<string>, searchQuery: string): T[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  let result: T[] = tools;
  if (normalizedQuery) {
    result = tools.filter((tool) => {
      const formattedName = parseFullToolName(tool.name).toolName || tool.name;
      return getToolSearchMatchScore(tool, formattedName, normalizedQuery) > 0;
    });
  }

  // Use original index as tiebreaker so sort order is deterministic
  // regardless of engine sort stability.
  const indexMap = new Map(result.map((t, i) => [t.id, i]));
  return [...result].sort((a, b) => {
    const aSelected = selectedToolIds.has(a.id) ? 0 : 1;
    const bSelected = selectedToolIds.has(b.id) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    const aFormattedName = parseFullToolName(a.name).toolName || a.name;
    const bFormattedName = parseFullToolName(b.name).toolName || b.name;
    const aScore = normalizedQuery
      ? getToolSearchMatchScore(a, aFormattedName, normalizedQuery)
      : 0;
    const bScore = normalizedQuery
      ? getToolSearchMatchScore(b, bFormattedName, normalizedQuery)
      : 0;
    if (aScore !== bScore) return bScore - aScore;
    return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
  });
}

/** Whether two ID sets contain exactly the same members. */
export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function getToolSearchMatchScore<T extends { description?: string | null }>(
  tool: T,
  formattedName: string,
  query: string,
) {
  const name = formattedName.toLowerCase();
  const description = tool.description?.toLowerCase() ?? "";

  if (name === query) return 5;
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (description.startsWith(query)) return 2;
  if (description.includes(query)) return 1;
  return 0;
}
