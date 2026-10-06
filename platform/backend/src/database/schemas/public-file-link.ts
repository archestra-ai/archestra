import {
  customType,
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

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
 * A link serves a FROZEN copy of the file taken at share time (`data`), not
 * the live file: a post scheduled hours ahead must fetch exactly what the user
 * approved, so later edits, overwrites, or deletion of the source file change
 * nothing. `fileId` is provenance only (set null when the source goes away).
 * Revoking is the one way to take a link down, and it drops the bytes
 * (`data` = null) — a revoked link can never serve again, so keeping them would
 * only grow storage. `filename`/`mimeType`/`sizeBytes` stay for the admin list.
 */
const publicFileLinksTable = pgTable(
  "public_file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    /** Source file, for provenance only; never read when serving. */
    fileId: uuid("file_id").references(() => filesTable.id, {
      onDelete: "set null",
    }),
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
    /** The frozen bytes the link serves; null once revoked. */
    data: bytea("data"),
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
