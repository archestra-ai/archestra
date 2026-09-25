import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";
import serviceAccountsTable from "./service-account";
import usersTable from "./user";

/**
 * A folder in the knowledge file repository. Flat — a directory never nests.
 *
 * `visibility` (and `kb_directory_team`) is retired: a document's audience is
 * the grants of its file, and nothing writes or reads a directory's audience
 * any more. The column stays until the retired sharing columns are dropped.
 */
const kbDirectoriesTable = pgTable(
  "kb_directories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    visibility: text("visibility")
      .$type<KnowledgeFileVisibility>()
      .notNull()
      .default("org-wide"),
    /** Author. Nulled rather than cascaded: the directory outlives them. */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("kb_directories_organization_id_idx").on(table.organizationId),
    uniqueIndex("kb_directories_org_name_uidx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export default kbDirectoriesTable;
