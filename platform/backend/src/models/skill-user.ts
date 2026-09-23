import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  DEFAULT_RESOURCE_USER_ACCESS_LEVEL,
  normalizeResourceUserInput,
  type ResourceUserInput,
} from "@/types/resource-user-level";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * Individually-named grants on a skill — the per-person counterpart to
 * `SkillTeamModel`. Sharing with one colleague no longer means publishing to a
 * whole team or the organization.
 */
class SkillUserModel {
  /**
   * Replace a skill's user grants with exactly `users`.
   *
   * An entry given as a bare id carries no level, which means "keep whatever is
   * stored", so an id-only caller can never silently escalate an existing `use`
   * grant to `write`. Genuinely new grants land at
   * {@link DEFAULT_RESOURCE_USER_ACCESS_LEVEL}.
   */
  static async syncSkillUsers(
    skillId: string,
    users: ResourceUserInput[],
    tx?: Transaction,
  ): Promise<number> {
    const assignments = normalizeResourceUserInput(users);
    logger.debug(
      { skillId, userCount: assignments.length },
      "SkillUserModel.syncSkillUsers: syncing users",
    );

    const run = async (t: Transaction) => {
      const existing = await t
        .select({
          userId: schema.skillUsersTable.userId,
          level: schema.skillUsersTable.level,
        })
        .from(schema.skillUsersTable)
        .where(eq(schema.skillUsersTable.skillId, skillId));
      const storedLevels = new Map(
        existing.map((row) => [row.userId, row.level]),
      );

      await t
        .delete(schema.skillUsersTable)
        .where(eq(schema.skillUsersTable.skillId, skillId));

      if (assignments.length > 0) {
        await t.insert(schema.skillUsersTable).values(
          assignments.map(({ id, level }) => ({
            skillId: skillId,
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

  /** Whether this skill has been shared with the user by name. */
  static async userHasGrant(skillId: string, userId: string): Promise<boolean> {
    const [match] = await db
      .select({ userId: schema.skillUsersTable.userId })
      .from(schema.skillUsersTable)
      .where(
        and(
          eq(schema.skillUsersTable.skillId, skillId),
          eq(schema.skillUsersTable.userId, userId),
        ),
      )
      .limit(1);
    return match !== undefined;
  }

  /** The skill ids, of those given, this user holds a grant on. */
  static async filterGrantedIds(
    skillIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (skillIds.length === 0) return new Set();
    const rows = await db
      .select({ id: schema.skillUsersTable.skillId })
      .from(schema.skillUsersTable)
      .where(
        and(
          inArray(schema.skillUsersTable.skillId, skillIds),
          eq(schema.skillUsersTable.userId, userId),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The people a skill's own policy grants read to, other than its author,
   * for the "shared with" list.
   */
  static async getUserDetailsForSkills(
    skillIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    if (skillIds.length === 0) return new Map();
    const authors = await db
      .select({
        id: schema.skillsTable.id,
        authorId: schema.skillsTable.authorId,
      })
      .from(schema.skillsTable)
      .where(inArray(schema.skillsTable.id, skillIds));
    const details =
      await ResourcePermissionPolicyModel.findReadRecipientDetails({
        resources: ["skill"],
        scopes: skillIds,
        excludeUserIds: new Map(authors.map((row) => [row.id, row.authorId])),
      });
    return new Map(skillIds.map((id) => [id, details.get(id)?.users ?? []]));
  }
}

export default SkillUserModel;
