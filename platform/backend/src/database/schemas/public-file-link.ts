import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import conversationsTable from "./conversation";
import filesTable from "./file";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * Public links to persistent files, created by the `share_file_publicly` tool
 * so an external service (a social scheduler, a CMS) can fetch the file
 * without logging in. Served unauthenticated at `/public-files/<token>/…`.
 *
 * The token IS the credential, and it is stored as-is (not hashed): admins
 * copy the full link from the shared-files list, and a link that is meant to
 * be posted on the public internet is not a secret worth hashing. It is
 * random (192 bits) so links cannot be guessed or enumerated.
 *
 * The link points at the `files` row, not a copy of its bytes: deleting the
 * file (or its project/author) removes the link. `filename`/`mimeType`/
 * `sizeBytes` are a snapshot taken at share time, for the admin list.
 */
const publicFileLinksTable = pgTable(
  "public_file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => filesTable.id, { onDelete: "cascade" }),
    /** Who asked the agent to share; null once that user is deleted. */
    createdByUserId: text("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("public_file_links_token_idx").on(table.token),
    index("public_file_links_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("public_file_links_file_id_idx").on(table.fileId),
  ],
);

export default publicFileLinksTable;
