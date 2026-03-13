import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import { team } from "./team";

const mcpCatalogTeamsTable = pgTable(
  "mcp_catalog_team",
  {
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogId, table.teamId] }),
  }),
);

export default mcpCatalogTeamsTable;
