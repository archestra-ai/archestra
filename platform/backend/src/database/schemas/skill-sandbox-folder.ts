import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import usersTable from "./user";

/**
 * A user's folders in their persistent X-Files storage (PFS). Flat — no
 * nesting. In filesystem storage mode a folder is also a real directory under
 * `<root>/<userId>/<name>`; in db mode this table is the only representation
 * (which is what lets empty folders exist there).
 *
 * Files reference folders via `skill_sandbox_files.folder_id` (SET NULL on
 * delete — defensive; there is no folder delete API yet).
 */
const skillSandboxFoldersTable = pgTable(
  "skill_sandbox_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Validated display name; also the on-disk directory name in filesystem mode. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // one folder name per user — names are the cross-provider identity
    // (filesystem directories have no row id to match on).
    uniqueIndex("skill_sandbox_folders_user_name_uidx").on(
      table.userId,
      table.name,
    ),
  ],
);

export default skillSandboxFoldersTable;
