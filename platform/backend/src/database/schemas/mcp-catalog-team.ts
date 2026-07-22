import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { CatalogTeamAccessLevel } from "@/types/catalog-team-level";
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
    // Defaults to `write`: an assignment created before per-team levels — and
    // any created without an explicit level — keeps the capability its team
    // already had.
    level: text("level")
      .$type<CatalogTeamAccessLevel>()
      .notNull()
      .default("write"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogId, table.teamId] }),
    // The API serializes `level` through a strict enum, so a value outside
    // `use`/`write` would fail response validation and break catalog reads.
    // Enforce the domain in the database too.
    levelCheck: check(
      "mcp_catalog_team_level_check",
      sql`
      ${table.level} in ('use', 'write')`,
    ),
  }),
);

export default mcpCatalogTeamsTable;
