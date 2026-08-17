import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";
import usersTable from "./user";

/**
 * A folder in the knowledge file repository. Flat — a directory never nests.
 *
 * `visibility` decides the audience tokens COPIED onto a document when a file
 * from this directory is indexed into a knowledge base. It is deliberately not
 * a `kb_container_acls` row: that table is owned exclusively by the
 * permission-sync pass, and an ordinary connector ACL refresh deletes every
 * container row for its connector, which would silently wipe an authored
 * audience. Copying direct tokens instead means a visibility change is one
 * UPDATE over this directory's documents and needs no cache invalidation.
 *
 * Because the tokens are copied at index time, changing this value re-ACLs
 * already-indexed documents explicitly (see `reindexDirectoryAcl`) rather than
 * taking effect implicitly.
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
