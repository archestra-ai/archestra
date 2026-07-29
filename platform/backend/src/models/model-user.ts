import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  DEFAULT_RESOURCE_USER_ACCESS_LEVEL,
  normalizeResourceUserInput,
  type ResourceUserInput,
} from "@/types/resource-user-level";

/**
 * Individually-named grants on a model — the per-person counterpart to
 * `ModelTeamModel`. Sharing with one colleague no longer means publishing to a
 * whole team or the organization.
 */
class ModelUserModel {
  /**
   * Replace a model's user grants with exactly `users`.
   *
   * An entry given as a bare id carries no level, which means "keep whatever is
   * stored", so an id-only caller can never silently escalate an existing `use`
   * grant to `write`. Genuinely new grants land at
   * {@link DEFAULT_RESOURCE_USER_ACCESS_LEVEL}.
   */
  static async syncModelUsers(
    modelId: string,
    users: ResourceUserInput[],
    tx?: Transaction,
  ): Promise<number> {
    const assignments = normalizeResourceUserInput(users);
    logger.debug(
      { modelId, userCount: assignments.length },
      "ModelUserModel.syncModelUsers: syncing users",
    );

    const run = async (t: Transaction) => {
      const existing = await t
        .select({
          userId: schema.modelUsersTable.userId,
          level: schema.modelUsersTable.level,
        })
        .from(schema.modelUsersTable)
        .where(eq(schema.modelUsersTable.modelId, modelId));
      const storedLevels = new Map(
        existing.map((row) => [row.userId, row.level]),
      );

      await t
        .delete(schema.modelUsersTable)
        .where(eq(schema.modelUsersTable.modelId, modelId));

      if (assignments.length > 0) {
        await t.insert(schema.modelUsersTable).values(
          assignments.map(({ id, level }) => ({
            modelId: modelId,
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

  /** Whether this model has been shared with the user by name. */
  static async userHasGrant(modelId: string, userId: string): Promise<boolean> {
    const [match] = await db
      .select({ userId: schema.modelUsersTable.userId })
      .from(schema.modelUsersTable)
      .where(
        and(
          eq(schema.modelUsersTable.modelId, modelId),
          eq(schema.modelUsersTable.userId, userId),
        ),
      )
      .limit(1);
    return match !== undefined;
  }

  /** The model ids, of those given, this user holds a grant on. */
  static async filterGrantedIds(
    modelIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (modelIds.length === 0) return new Set();
    const rows = await db
      .select({ id: schema.modelUsersTable.modelId })
      .from(schema.modelUsersTable)
      .where(
        and(
          inArray(schema.modelUsersTable.modelId, modelIds),
          eq(schema.modelUsersTable.userId, userId),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /** Grantee details for several models in one query (no N+1). */
  static async getUserDetailsForModels(
    modelIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    const map = new Map<
      string,
      Array<{ id: string; name: string; email: string }>
    >();
    for (const id of modelIds) map.set(id, []);
    if (modelIds.length === 0) return map;

    const rows = await db
      .select({
        resourceId: schema.modelUsersTable.modelId,
        userId: schema.modelUsersTable.userId,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
      })
      .from(schema.modelUsersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.modelUsersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.modelUsersTable.modelId, modelIds));

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

export default ModelUserModel;
