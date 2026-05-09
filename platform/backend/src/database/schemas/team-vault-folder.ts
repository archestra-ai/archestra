import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";
import { team } from "./team";

/**
 * Team Vault folder mapping table.
 * Maps a team to an external HashiCorp Vault folder path.
 * Used for authorization - determines which Vault paths a team can access.
 */
const teamVaultFolderTable = pgTable(
  "team_vault_folder",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    /** Vault folder path, e.g., "secret/data/engineering" */
    vaultPath: text("vault_path").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex("team_vault_folder_team_id_uidx")
      .on(table.teamId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default teamVaultFolderTable;
