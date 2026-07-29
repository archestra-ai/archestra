import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { CatalogUserAccessLevel } from "@/types/catalog-user-level";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import usersTable from "./user";

/**
 * Individually-named users granted access to a `user`-scoped catalog item, the
 * per-person analogue of `mcp_catalog_team`. Apps are the only surface that
 * reads it today: chats can be shared with named people, and an app rendered in
 * one had no way to follow without widening it to a whole team or organization.
 *
 * Keeping it on the catalog rather than on `apps` preserves the catalog as the
 * single source of truth for an app's visibility, so every reader — the REST
 * detail route and the app runtime endpoint alike — picks the grant up through
 * the one access check they already share.
 */
const mcpCatalogUsersTable = pgTable(
  "mcp_catalog_user",
  {
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Defaults to `use`: a per-user grant is a new concept with no history to
    // preserve, so it starts at least privilege (run the app, not rewrite it).
    level: text("level")
      .$type<CatalogUserAccessLevel>()
      .notNull()
      .default("use"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogId, table.userId] }),
    // The API serializes `level` through a strict enum, so a value outside
    // `use`/`write` would fail response validation. Enforce it in the database
    // too, matching `mcp_catalog_team_level_check`.
    levelCheck: check(
      "mcp_catalog_user_level_check",
      sql`
      ${table.level} in ('use', 'write')`,
    ),
  }),
);

export default mcpCatalogUsersTable;
