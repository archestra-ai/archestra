import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import oauthClient from "./oauth-client";

/**
 * Key/value labels attached to OAuth clients.
 *
 * The primary key is (clientId, key_id), so an OAuth client carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const oauthClientLabelsTable = pgTable(
  "oauth_client_labels",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.keyId] })],
);

export default oauthClientLabelsTable;
