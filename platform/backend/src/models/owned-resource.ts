import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq, inArray, ne, not, type SQL, sql } from "drizzle-orm";
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

/** One resource a user owns, and whether anyone besides them can reach it. */
export type OwnedResource = {
  kind: OwnedResourceKind;
  id: string;
  name: string;
  /** Someone other than the owner can read or use it. */
  shared: boolean;
};

/**
 * Cross-table lookups over what a user owns (their `author_id`), used when a
 * member leaves the organization and their shared resources change hands.
 */
class OwnedResourceModel {
  /**
   * Every resource a user owns in an organization, with whether anyone besides
   * the owner can read or use it. Platform-managed rows (built-in agents,
   * personal gateways and proxies, the Archestra MCP server, app-backed
   * catalog entries) are left out: they never change hands.
   */
  static async findByOwner(params: {
    userId: string;
    organizationId: string;
  }): Promise<OwnedResource[]> {
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
          .select({
            id: agents.id,
            name: agents.name,
            agentType: agents.agentType,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            // Agents and gateways share a table; their grants live under
            // different resources.
            shared: sql<boolean>`CASE WHEN ${agents.agentType} = 'mcp_gateway' THEN ${sharedWithOthers(
              {
                organizationId,
                resource: "mcpGateway",
                scopeColumn: agents.id,
                ownerColumn: agents.authorId,
              },
            )} ELSE ${sharedWithOthers({
              organizationId,
              resource: "agent",
              scopeColumn: agents.id,
              ownerColumn: agents.authorId,
            })} END`,
            // SPDX-SnippetEnd
          })
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
            ),
          ),
        db
          .select({
            id: skills.id,
            name: skills.name,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            shared: sharedWithOthers({
              organizationId,
              resource: "skill",
              scopeColumn: skills.id,
              ownerColumn: skills.authorId,
            }),
            // SPDX-SnippetEnd
          })
          .from(skills)
          .where(
            and(
              eq(skills.organizationId, organizationId),
              eq(skills.authorId, userId),
              notDeleted(skills),
            ),
          ),
        db
          .select({
            id: plugins.id,
            name: plugins.displayName,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            shared: sharedWithOthers({
              organizationId,
              resource: "plugin",
              scopeColumn: plugins.id,
              ownerColumn: plugins.authorId,
            }),
            // SPDX-SnippetEnd
          })
          .from(plugins)
          .where(
            and(
              eq(plugins.organizationId, organizationId),
              eq(plugins.authorId, userId),
              notDeleted(plugins),
            ),
          ),
        db
          .select({
            id: catalog.id,
            name: catalog.name,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            shared: sharedWithOthers({
              organizationId,
              resource: "mcpRegistry",
              scopeColumn: catalog.id,
              ownerColumn: catalog.authorId,
            }),
            // SPDX-SnippetEnd
          })
          .from(catalog)
          .where(
            and(
              eq(catalog.organizationId, organizationId),
              eq(catalog.authorId, userId),
              notDeleted(catalog),
              ne(catalog.id, ARCHESTRA_MCP_CATALOG_ID),
              ne(catalog.serverType, "app"),
            ),
          ),
        db
          .select({
            id: apps.id,
            name: apps.name,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            shared: sharedWithOthers({
              organizationId,
              resource: "app",
              scopeColumn: apps.id,
              ownerColumn: apps.authorId,
            }),
            // SPDX-SnippetEnd
          })
          .from(apps)
          .where(
            and(
              eq(apps.organizationId, organizationId),
              eq(apps.authorId, userId),
              notDeleted(apps),
            ),
          ),
        db
          .select({
            id: remoteAgents.id,
            name: remoteAgents.name,
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            shared: sharedWithOthers({
              organizationId,
              resource: "externalAgent",
              scopeColumn: remoteAgents.id,
              ownerColumn: remoteAgents.authorId,
            }),
            // SPDX-SnippetEnd
          })
          .from(remoteAgents)
          .where(
            and(
              eq(remoteAgents.organizationId, organizationId),
              eq(remoteAgents.authorId, userId),
            ),
          ),
      ]);

    const row =
      (kind: OwnedResourceKind) =>
      (r: { id: string; name: string; shared: boolean }): OwnedResource => ({
        kind,
        id: r.id,
        name: r.name,
        shared: Boolean(r.shared),
      });
    return [
      ...agentRows.map((r) =>
        row(r.agentType === "mcp_gateway" ? "mcpGateway" : "agent")(r),
      ),
      ...skillRows.map(row("skill")),
      ...pluginRows.map(row("plugin")),
      ...catalogRows.map(row("catalog")),
      ...appRows.map(row("app")),
      ...remoteRows.map(row("remoteAgent")),
    ];
  }

  /**
   * {@link findByOwner}, keeping only what someone besides the owner can read
   * or use. Resources only the owner can reach are personal and are deleted
   * with the owner instead.
   */
  static async findSharedByOwner(params: {
    userId: string;
    organizationId: string;
  }): Promise<{ kind: OwnedResourceKind; id: string }[]> {
    return (await OwnedResourceModel.findByOwner(params))
      .filter((resource) => resource.shared)
      .map(({ kind, id }) => ({ kind, id }));
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
): SQL<boolean> {
  return not(
    ResourcePermissionPolicyModel.reachesOnlyOwner(params),
  ) as SQL<boolean>;
}
// SPDX-SnippetEnd
