import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq, inArray, ne, not, or, type SQL } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/** A kind of resource that changes hands when its owner leaves. */
export type OwnedResourceKind =
  | "agent"
  | "mcpGateway"
  | "skill"
  | "plugin"
  | "catalog"
  | "app"
  | "remoteAgent";

/**
 * Cross-table lookups over what a user owns (their `author_id`), used when a
 * member leaves the organization and their shared resources change hands.
 */
class OwnedResourceModel {
  /**
   * The resources a user owns in an organization that someone other than the
   * owner can read or use. Resources only the owner can reach are left out:
   * they are personal and are deleted with the owner instead. Platform-managed
   * rows (built-in agents, personal gateways and proxies, the Archestra MCP
   * server, app-backed catalog entries) are left out too.
   */
  static async findSharedByOwner(params: {
    userId: string;
    organizationId: string;
  }): Promise<{ kind: OwnedResourceKind; id: string }[]> {
    const { userId, organizationId } = params;
    const agents = schema.agentsTable;
    const skills = schema.skillsTable;
    const plugins = schema.pluginsTable;
    const catalog = schema.internalMcpCatalogTable;
    const apps = schema.appsTable;
    const remoteAgents = schema.a2aRemoteAgentsTable;

    const [agentRows, skillRows, pluginRows, catalogRows, appRows, remoteRows] =
      await Promise.all([
        db
          .select({ id: agents.id, agentType: agents.agentType })
          .from(agents)
          .where(
            and(
              eq(agents.organizationId, organizationId),
              eq(agents.authorId, userId),
              notDeleted(agents),
              eq(agents.builtIn, false),
              eq(agents.isPersonalGateway, false),
              eq(agents.isPersonalProxy, false),
              inArray(agents.agentType, ["agent", "profile", "mcp_gateway"]),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              // Agents and gateways share a table; their grants live under
              // different resources.
              or(
                and(
                  inArray(agents.agentType, ["agent", "profile"]),
                  sharedWithOthers({
                    organizationId,
                    resource: "agent",
                    scopeColumn: agents.id,
                    ownerColumn: agents.authorId,
                  }),
                ),
                and(
                  eq(agents.agentType, "mcp_gateway"),
                  sharedWithOthers({
                    organizationId,
                    resource: "mcpGateway",
                    scopeColumn: agents.id,
                    ownerColumn: agents.authorId,
                  }),
                ),
              ),
              // SPDX-SnippetEnd
            ),
          ),
        db
          .select({ id: skills.id })
          .from(skills)
          .where(
            and(
              eq(skills.organizationId, organizationId),
              eq(skills.authorId, userId),
              notDeleted(skills),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              sharedWithOthers({
                organizationId,
                resource: "skill",
                scopeColumn: skills.id,
                ownerColumn: skills.authorId,
              }),
              // SPDX-SnippetEnd
            ),
          ),
        db
          .select({ id: plugins.id })
          .from(plugins)
          .where(
            and(
              eq(plugins.organizationId, organizationId),
              eq(plugins.authorId, userId),
              notDeleted(plugins),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              sharedWithOthers({
                organizationId,
                resource: "plugin",
                scopeColumn: plugins.id,
                ownerColumn: plugins.authorId,
              }),
              // SPDX-SnippetEnd
            ),
          ),
        db
          .select({ id: catalog.id })
          .from(catalog)
          .where(
            and(
              eq(catalog.organizationId, organizationId),
              eq(catalog.authorId, userId),
              notDeleted(catalog),
              ne(catalog.id, ARCHESTRA_MCP_CATALOG_ID),
              ne(catalog.serverType, "app"),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              sharedWithOthers({
                organizationId,
                resource: "mcpRegistry",
                scopeColumn: catalog.id,
                ownerColumn: catalog.authorId,
              }),
              // SPDX-SnippetEnd
            ),
          ),
        db
          .select({ id: apps.id })
          .from(apps)
          .where(
            and(
              eq(apps.organizationId, organizationId),
              eq(apps.authorId, userId),
              notDeleted(apps),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              sharedWithOthers({
                organizationId,
                resource: "app",
                scopeColumn: apps.id,
                ownerColumn: apps.authorId,
              }),
              // SPDX-SnippetEnd
            ),
          ),
        db
          .select({ id: remoteAgents.id })
          .from(remoteAgents)
          .where(
            and(
              eq(remoteAgents.organizationId, organizationId),
              eq(remoteAgents.authorId, userId),
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              sharedWithOthers({
                organizationId,
                resource: "externalAgent",
                scopeColumn: remoteAgents.id,
                ownerColumn: remoteAgents.authorId,
              }),
              // SPDX-SnippetEnd
            ),
          ),
      ]);

    return [
      ...agentRows.map((row) => ({
        kind: (row.agentType === "mcp_gateway"
          ? "mcpGateway"
          : "agent") as OwnedResourceKind,
        id: row.id,
      })),
      ...skillRows.map((row) => ({ kind: "skill" as const, id: row.id })),
      ...pluginRows.map((row) => ({ kind: "plugin" as const, id: row.id })),
      ...catalogRows.map((row) => ({ kind: "catalog" as const, id: row.id })),
      ...appRows.map((row) => ({ kind: "app" as const, id: row.id })),
      ...remoteRows.map((row) => ({
        kind: "remoteAgent" as const,
        id: row.id,
      })),
    ];
  }
}

export default OwnedResourceModel;

// ===================================================================
// Internal helpers
// ===================================================================

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * True when the object's own permission policy lets someone other than the
 * owner read or use it.
 */
function sharedWithOthers(
  params: Parameters<typeof ResourcePermissionPolicyModel.reachesOnlyOwner>[0],
): SQL {
  return not(ResourcePermissionPolicyModel.reachesOnlyOwner(params));
}
// SPDX-SnippetEnd
