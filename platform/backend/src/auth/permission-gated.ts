import type { Action, Resource } from "@archestra/shared";
import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import db, { schema } from "@/database";
import { SRE_AGENT_ID, SRE_CATALOG_ID } from "@/services/sre-agent/definition";
import { ApiError } from "@/types";

type RequiredPermission = readonly [Resource, Action];

const SRE_PERMISSION: RequiredPermission = ["sre", "read"];

/**
 * Agents and MCP catalog items only a holder of a role permission may see or
 * use, whatever their grants — admins included.
 */
const PERMISSION_GATED_AGENTS: ReadonlyMap<string, RequiredPermission> =
  new Map([[SRE_AGENT_ID, SRE_PERMISSION]]);
const PERMISSION_GATED_CATALOGS: ReadonlyMap<string, RequiredPermission> =
  new Map([[SRE_CATALOG_ID, SRE_PERMISSION]]);

interface Caller {
  userId?: string | null;
  organizationId?: string | null;
}

type UserCaller = { kind: "caller" } & Caller;

/**
 * Who a gated catalog's tools are read for, or its server is connected for.
 * `internal` skips the gate, and is only for maintenance that stores what the
 * server advertises or serves no caller.
 */
export type GatedCaller =
  | UserCaller
  | {
      kind: "internal";
      purpose:
        | "tool-discovery"
        | "skills-discovery"
        | "install"
        | "docs-server"
        | "app-backing"
        | "scheduled-run";
    };

/** The user or service account a token-authenticated call runs for. */
export function callerOf(tokenAuth?: {
  userId?: string;
  serviceAccountId?: string;
  organizationId?: string;
}): UserCaller {
  return {
    kind: "caller",
    userId: tokenAuth?.serviceAccountId
      ? serviceAccountUserId(tokenAuth.serviceAccountId)
      : tokenAuth?.userId,
    organizationId: tokenAuth?.organizationId,
  };
}

export function isPermissionGatedAgent(agentId: string): boolean {
  return PERMISSION_GATED_AGENTS.has(agentId);
}

/** Whether a caller, of a token or none, may use a gated agent. */
export function canUseAgent(agentId: string, caller: Caller): Promise<boolean> {
  return callerHolds(PERMISSION_GATED_AGENTS.get(agentId), caller);
}

export function mayUseCatalog(
  catalogId: string | null,
  caller: GatedCaller,
): Promise<boolean> {
  return caller.kind === "internal" || catalogId === null
    ? Promise.resolve(true)
    : canUseCatalog(catalogId, caller);
}

/** Refuses a connection to a gated catalog's server as if it did not exist. */
export async function assertMayConnect(
  catalogId: string,
  caller: GatedCaller,
): Promise<void> {
  if (!(await mayUseCatalog(catalogId, caller)))
    throw new ApiError(404, "MCP server not found");
}

/** The gated agents among `agentIds` the caller may not see; free unless one is present. */
export async function hiddenAgentsAmong(
  agentIds: Iterable<string | null | undefined>,
  caller: GatedCaller,
): Promise<ReadonlySet<string>> {
  if (caller.kind === "internal") return new Set();
  const gated = [...new Set(agentIds)].filter(
    (id): id is string => !!id && isPermissionGatedAgent(id),
  );
  const visible = await Promise.all(gated.map((id) => canUseAgent(id, caller)));
  return new Set(gated.filter((_, index) => !visible[index]));
}

/** The gated agents of an organization the caller may not see. */
export async function hiddenAgentIds(caller: {
  userId: string;
  organizationId: string;
}): Promise<string[]> {
  const ids = [...PERMISSION_GATED_AGENTS.keys()];
  const visible = await Promise.all(ids.map((id) => canUseAgent(id, caller)));
  return ids.filter((_, index) => !visible[index]);
}

/**
 * Whether a caller may see a gated agent of an organization. Lookups without
 * any caller are internal and never reach this.
 */
export function canSeeAgent(params: {
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return canUseAgent(params.agentId, params);
}

/** Whether a caller may reach a gated catalog item's tools. */
function canUseCatalog(catalogId: string, caller: Caller): Promise<boolean> {
  return callerHolds(PERMISSION_GATED_CATALOGS.get(catalogId), caller);
}

/**
 * Keeps each gated agent only in the organizations, among `organizationIds`,
 * where the caller holds its permission.
 */
export async function gatedAgentsFence(caller: {
  userId: string;
  organizationIds: string[];
}): Promise<SQL | undefined> {
  const table = schema.agentsTable;
  const organizationIds = [...new Set(caller.organizationIds)];
  const conditions = await Promise.all(
    [...PERMISSION_GATED_AGENTS.keys()].map(async (agentId) => {
      const visibleIn: string[] = [];
      for (const organizationId of organizationIds) {
        if (
          await canSeeAgent({ agentId, userId: caller.userId, organizationId })
        )
          visibleIn.push(organizationId);
      }
      return visibleIn.length > 0
        ? or(ne(table.id, agentId), inArray(table.organizationId, visibleIn))
        : ne(table.id, agentId);
    }),
  );
  return and(...conditions);
}

/**
 * Drops the gated agents the caller may not see from rows already read. For
 * unpaginated reads: it looks the permission up only when a gated agent is
 * among the rows, so other reads pay nothing.
 */
export async function dropHiddenAgents<
  T extends { id: string; organizationId?: string },
>(rows: T[], userId: string): Promise<T[]> {
  const visible = await Promise.all(
    rows.map(async (row) => {
      if (!isPermissionGatedAgent(row.id)) return true;
      const organizationId =
        row.organizationId ?? (await agentOrganizationId(row.id));
      return (
        !!organizationId &&
        canSeeAgent({ agentId: row.id, userId, organizationId })
      );
    }),
  );
  return rows.filter((_, index) => visible[index]);
}

/**
 * Drops tools of gated catalogs the caller may not use, and delegations to
 * gated agents they may not see; free unless one is present.
 */
export async function dropHiddenTools<
  T extends { catalogId: string | null; delegateToAgentId: string | null },
>(
  tools: T[],
  caller: { userId: string; organizationId: string },
): Promise<T[]> {
  const { denied } = await splitGatedCatalogs(
    tools.map(({ catalogId }) => catalogId),
    caller,
  );
  const deniedCatalogs = new Set(denied);
  const hiddenAgents = new Set(
    tools.some(
      ({ delegateToAgentId }) =>
        delegateToAgentId && isPermissionGatedAgent(delegateToAgentId),
    )
      ? await hiddenAgentIds(caller)
      : [],
  );
  return tools.filter(
    ({ catalogId, delegateToAgentId }) =>
      !(catalogId && deniedCatalogs.has(catalogId)) &&
      !(delegateToAgentId && hiddenAgents.has(delegateToAgentId)),
  );
}

/** Drops the gated catalog ids the caller may not use; free unless one is present. */
export async function dropHiddenCatalogIds(
  catalogIds: string[],
  caller: Caller,
): Promise<string[]> {
  const usable = await Promise.all(
    catalogIds.map(
      (id) => !PERMISSION_GATED_CATALOGS.has(id) || canUseCatalog(id, caller),
    ),
  );
  return catalogIds.filter((_, index) => usable[index]);
}

/** Gated catalogs among `catalogIds` the caller may and may not use. */
export async function splitGatedCatalogs(
  catalogIds: Iterable<string | null>,
  caller: Caller,
): Promise<{ usable: string[]; denied: string[] }> {
  const gated = [...new Set(catalogIds)].filter(
    (id): id is string => id !== null && PERMISSION_GATED_CATALOGS.has(id),
  );
  const usable = new Set(await dropHiddenCatalogIds(gated, caller));
  return {
    usable: [...usable],
    denied: gated.filter((id) => !usable.has(id)),
  };
}

/** Drops tools of gated catalogs the caller may not use, on a `tools` query. */
export async function gatedCatalogToolsFence(
  caller: Caller,
): Promise<SQL | undefined> {
  const { denied } = await splitGatedCatalogs(
    PERMISSION_GATED_CATALOGS.keys(),
    caller,
  );
  return denied.length > 0
    ? or(
        isNull(schema.toolsTable.catalogId),
        notInArray(schema.toolsTable.catalogId, denied),
      )
    : undefined;
}

// === Internal ===

/**
 * The `system` sentinel, and callers without a user or organization (team and
 * organization tokens), hold no role permission.
 */
async function callerHolds(
  required: RequiredPermission | undefined,
  { userId, organizationId }: Caller,
): Promise<boolean> {
  if (!required) return true;
  if (!userId || !organizationId || userId === "system") return false;
  // Dynamic: @/auth/utils reaches the agent model through better-auth.
  const { userHasPermission } = await import("@/auth/utils");
  return userHasPermission(userId, organizationId, ...required);
}

async function agentOrganizationId(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: schema.agentsTable.organizationId })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, agentId))
    .limit(1);
  return row?.organizationId ?? null;
}
