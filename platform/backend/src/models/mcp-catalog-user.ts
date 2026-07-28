import { eq } from "drizzle-orm";
import { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  type CatalogUserInput,
  DEFAULT_CATALOG_USER_ACCESS_LEVEL,
  normalizeCatalogUserInput,
} from "@/types/catalog-user-level";

/**
 * Write side for individually-named grants on a catalog item — the per-person
 * counterpart to `McpCatalogTeamModel`. Reads live in `AppAccessModel`, which
 * resolves a grant through the same join chain as every other app access check.
 */
class McpCatalogUserModel {
  /**
   * Replace a catalog's user grants with exactly `users`.
   *
   * Mirrors `syncCatalogTeams`, including its level handling: an entry given as
   * a bare id carries no level, which means "keep whatever is stored", so an
   * id-only caller can never silently escalate an existing `use` grant to
   * `write`. Genuinely new grants land at
   * {@link DEFAULT_CATALOG_USER_ACCESS_LEVEL}.
   */
  static async syncCatalogUsers(
    catalogId: string,
    users: CatalogUserInput[],
    tx?: Transaction,
  ): Promise<number> {
    const assignments = normalizeCatalogUserInput(users);
    logger.debug(
      { catalogId, userCount: assignments.length },
      "McpCatalogUserModel.syncCatalogUsers: syncing users",
    );

    const run = async (t: Transaction) => {
      const existing = await t
        .select({
          userId: schema.mcpCatalogUsersTable.userId,
          level: schema.mcpCatalogUsersTable.level,
        })
        .from(schema.mcpCatalogUsersTable)
        .where(eq(schema.mcpCatalogUsersTable.catalogId, catalogId));
      const storedLevels = new Map(
        existing.map((row) => [row.userId, row.level]),
      );

      await t
        .delete(schema.mcpCatalogUsersTable)
        .where(eq(schema.mcpCatalogUsersTable.catalogId, catalogId));

      if (assignments.length > 0) {
        await t.insert(schema.mcpCatalogUsersTable).values(
          assignments.map(({ id, level }) => ({
            catalogId,
            userId: id,
            level:
              level ??
              storedLevels.get(id) ??
              DEFAULT_CATALOG_USER_ACCESS_LEVEL,
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
}

export default McpCatalogUserModel;
