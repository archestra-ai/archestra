import { eq, inArray, type SQL, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";

/**
 * Team assignments for OAuth clients (both MCP gateway and LLM proxy clients —
 * they share the `oauth_client` table, discriminated by `metadata.type`, so one
 * junction model serves both). Follows the same 3-tier visibility model as
 * agents/skills/catalog: `scope` and `authorId` live in the client's JSONB
 * metadata; team rows are only consulted for `team`-scoped clients.
 *
 * Scoping is a management-plane concern only: it governs who can see and manage
 * a credential. Runtime token validation (`findByClientId` /
 * `findClientForCredentials`) never consults it.
 */
class OauthClientTeamModel {
  /**
   * SQL condition restricting `oauth_client` rows to those a non-admin user may
   * see: org-scoped (legacy rows without a scope parse as org), their own
   * personal clients, and team-scoped clients of teams they belong to.
   * Composed into the models' `findAllByOrganization` where-clauses; callers
   * with the resource's `admin` action skip it entirely.
   */
  static accessibleScopeCondition(userId: string): SQL {
    return sql`(
      COALESCE(${schema.oauthClientsTable.metadata}->>'scope', 'org') = 'org'
      OR (
        ${schema.oauthClientsTable.metadata}->>'scope' = 'personal'
        AND ${schema.oauthClientsTable.metadata}->>'authorId' = ${userId}
      )
      OR (
        ${schema.oauthClientsTable.metadata}->>'scope' = 'team'
        AND EXISTS (
          SELECT 1 FROM oauth_client_team oct
          INNER JOIN team_member tm ON oct.team_id = tm.team_id
          WHERE oct.oauth_client_id = ${schema.oauthClientsTable.id}
            AND tm.user_id = ${userId}
        )
      )
    )`;
  }

  /**
   * Sync team assignments for an OAuth client (replaces all existing
   * assignments; an empty array clears them).
   */
  static async syncTeams(
    oauthClientId: string,
    teamIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    logger.debug(
      { oauthClientId, teamCount: teamIds.length },
      "OauthClientTeamModel.syncTeams: syncing teams",
    );
    const run = async (t: Transaction) => {
      await t
        .delete(schema.oauthClientTeamsTable)
        .where(eq(schema.oauthClientTeamsTable.oauthClientId, oauthClientId));

      if (teamIds.length > 0) {
        await t.insert(schema.oauthClientTeamsTable).values(
          teamIds.map((teamId) => ({
            oauthClientId,
            teamId,
          })),
        );
      }
    };
    if (tx) {
      await run(tx);
    } else {
      await withDbTransaction(run);
    }
  }

  /**
   * Get team details for multiple OAuth clients in one query to avoid N+1.
   * Every requested id is present in the map (empty array when unassigned).
   */
  static async getTeamDetailsForClients(
    oauthClientIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const teamsMap = new Map<string, Array<{ id: string; name: string }>>();
    for (const id of oauthClientIds) {
      teamsMap.set(id, []);
    }
    if (oauthClientIds.length === 0) return teamsMap;

    const clientTeams = await db
      .select({
        oauthClientId: schema.oauthClientTeamsTable.oauthClientId,
        teamId: schema.oauthClientTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.oauthClientTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.oauthClientTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(
        inArray(schema.oauthClientTeamsTable.oauthClientId, oauthClientIds),
      );

    for (const { oauthClientId, teamId, teamName } of clientTeams) {
      teamsMap.get(oauthClientId)?.push({ id: teamId, name: teamName });
    }

    return teamsMap;
  }
}

export default OauthClientTeamModel;
