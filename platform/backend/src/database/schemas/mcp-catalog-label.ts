import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

const mcpCatalogLabelsTable = pgTable(
  "mcp_catalog_labels",
  {
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogId, table.keyId] }),
  }),
);

export default mcpCatalogLabelsTable;
