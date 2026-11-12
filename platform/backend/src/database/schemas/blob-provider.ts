import type { BlobProviderType } from "@archestra/shared";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { BlobProviderConfig } from "@/types/blob-provider";
import organizationsTable from "./organization";
import secretsTable from "./secret";

/**
 * An organization's object storage destination (for example an S3 bucket),
 * configured once and written to by any feature that exports files (cost
 * exports today). `config` holds the non-secret settings for the provider
 * `type`; credentials live in the secrets manager behind `secret_id`, and are
 * never returned by the API.
 */
const blobProvidersTable = pgTable(
  "blob_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    type: varchar("type").$type<BlobProviderType>().notNull(),
    config: jsonb("config").$type<BlobProviderConfig>().notNull(),
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("blob_providers_organization_id_name_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export default blobProvidersTable;
