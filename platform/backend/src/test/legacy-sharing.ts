import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentTeamModel from "@/models/agent-team";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import type { ResourceVisibilityScope } from "@/types/visibility";

/**
 * The retired sharing columns and team rows an object carried before
 * permission policies. Only the upgrade (the scoped-permission cutover) and a
 * few readers of the team rows (`agent_team`, `mcp_catalog_team`) still use
 * them, so only their tests set this. It never changes who can reach the
 * object: that is the fixture's `access`.
 */
export type LegacySharing = {
  scope: ResourceVisibilityScope;
  teams?: Array<string | { id: string; level?: "use" | "write" }>;
};

/**
 * Write `legacy` onto an agent or catalog item a fixture just created, the way
 * the create path stored sharing before permission policies.
 */
export async function seedLegacySharing(params: {
  resource: "agent" | "mcpCatalog";
  id: string;
  legacy: LegacySharing;
}): Promise<void> {
  const { resource, id, legacy } = params;
  const teams = legacy.teams ?? [];
  if (resource === "agent") {
    await db
      .update(schema.agentsTable)
      .set({ scope: legacy.scope })
      .where(eq(schema.agentsTable.id, id));
    if (teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(
        id,
        teams.map((team) => (typeof team === "string" ? team : team.id)),
      );
    }
    return;
  }
  await db
    .update(schema.internalMcpCatalogTable)
    .set({ scope: legacy.scope })
    .where(eq(schema.internalMcpCatalogTable.id, id));
  if (teams.length > 0) await McpCatalogTeamModel.syncCatalogTeams(id, teams);
}
