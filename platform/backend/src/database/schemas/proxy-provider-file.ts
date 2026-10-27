import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Provider file metadata only. Provider bytes never enter Archestra file storage. */
const proxyProviderFilesTable = pgTable(
  "proxy_provider_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    provider: text("provider").notNull(),
    accountBinding: text("account_binding").notNull(),
    upstreamFileId: text("upstream_file_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    purpose: text("purpose").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("proxy_provider_files_scope_idx").on(
      table.organizationId,
      table.principalKind,
      table.principalId,
      table.provider,
      table.accountBinding,
    ),
  ],
);

export default proxyProviderFilesTable;
