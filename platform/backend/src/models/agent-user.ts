import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  DEFAULT_RESOURCE_USER_ACCESS_LEVEL,
  normalizeResourceUserInput,
  type ResourceUserInput,
} from "@/types/resource-user-level";

/**
 * Individually-named grants on an agent — the per-person counterpart to
 * `AgentTeamModel`. Sharing with one colleague no longer means publishing to a
 * whole team or the organization.
 */
class AgentUserModel {
  /**
   * Replace an agent's user grants with exactly `users`.
   *
   * An entry given as a bare id carries no level, which means "keep whatever is
   * stored", so an id-only caller can never silently escalate an existing `use`
   * grant to `write`. Genuinely new grants land at
   * {@link DEFAULT_RESOURCE_USER_ACCESS_LEVEL}.
   */
  static async syncAgentUsers(
    agentId: string,
    users: ResourceUserInput[],
    tx?: Transaction,
  ): Promise<number> {
    const assignments = normalizeResourceUserInput(users);
    logger.debug(
      { agentId, userCount: assignments.length },
      "AgentUserModel.syncAgentUsers: syncing users",
    );

    const run = async (t: Transaction) => {
      const existing = await t
        .select({
          userId: schema.agentUsersTable.userId,
          level: schema.agentUsersTable.level,
        })
        .from(schema.agentUsersTable)
        .where(eq(schema.agentUsersTable.agentId, agentId));
      const storedLevels = new Map(
        existing.map((row) => [row.userId, row.level]),
      );

      await t
        .delete(schema.agentUsersTable)
        .where(eq(schema.agentUsersTable.agentId, agentId));

      if (assignments.length > 0) {
        await t.insert(schema.agentUsersTable).values(
          assignments.map(({ id, level }) => ({
            agentId: agentId,
            userId: id,
            level:
              level ??
              storedLevels.get(id) ??
              DEFAULT_RESOURCE_USER_ACCESS_LEVEL,
          })),
        );
      }
    };

    if (tx) {
      await run(tx);
    } else {
      await withDbTransaction(run);
    }

    return assignments.length;
  }

  /** Whether this agent has been shared with the user by name. */
  static async userHasGrant(agentId: string, userId: string): Promise<boolean> {
    const [match] = await db
      .select({ userId: schema.agentUsersTable.userId })
      .from(schema.agentUsersTable)
      .where(
        and(
          eq(schema.agentUsersTable.agentId, agentId),
          eq(schema.agentUsersTable.userId, userId),
        ),
      )
      .limit(1);
    return match !== undefined;
  }

  /** The agent ids, of those given, this user holds a grant on. */
  static async filterGrantedIds(
    agentIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (agentIds.length === 0) return new Set();
    const rows = await db
      .select({ id: schema.agentUsersTable.agentId })
      .from(schema.agentUsersTable)
      .where(
        and(
          inArray(schema.agentUsersTable.agentId, agentIds),
          eq(schema.agentUsersTable.userId, userId),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /** Grantee details for several agents in one query (no N+1). */
  static async getUserDetailsForAgents(
    agentIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    const map = new Map<
      string,
      Array<{ id: string; name: string; email: string }>
    >();
    for (const id of agentIds) map.set(id, []);
    if (agentIds.length === 0) return map;

    const rows = await db
      .select({
        resourceId: schema.agentUsersTable.agentId,
        userId: schema.agentUsersTable.userId,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
      })
      .from(schema.agentUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.agentUsersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.agentUsersTable.agentId, agentIds));

    for (const { resourceId, userId, userName, userEmail } of rows) {
      map.get(resourceId)?.push({
        id: userId,
        name: userName,
        email: userEmail,
      });
    }
    return map;
  }
}

export default AgentUserModel;
