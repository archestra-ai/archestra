import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { McpCatalogConfigSnapshot } from "@/types/internal-mcp-catalog-version";
import internalMcpCatalogTable from "./internal-mcp-catalog";

/**
 * Immutable snapshot of a catalog item's configuration (the
 * internal_mcp_catalog row's config surface — see
 * McpCatalogConfigSnapshotSchema for the exact fields). Every config write
 * that changes the canonical payload forks a new version (`version`
 * increments per catalog from 1); a write producing an identical payload
 * reuses the head. `internal_mcp_catalog.latest_version` points at the head
 * (0 = legacy row that predates versioning and has not been written to
 * since).
 *
 * Rows are never updated, only appended and aged out: a fork trims versions
 * below the retention window (see MAX_VERSIONS_PER_CATALOG in the model), so
 * `version` numbers stay monotonic but the oldest are not kept forever.
 *
 * Like `agent_versions` (and unlike `app_versions`), `catalog_id` is NOT NULL
 * and ON DELETE CASCADE: nothing pins a catalog version, so the history of a
 * hard-deleted catalog item has no consumer and is removed with it.
 *
 * App-backed rows (`serverType: "app"`) are never versioned here: their
 * catalog row is written by AppModel outside the fork hooks, and their
 * content history already lives in `app_versions`.
 */
const internalMcpCatalogVersionsTable = pgTable(
  "mcp_catalog_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    /** Per-catalog version number, starting at 1. */
    version: integer("version").notNull(),
    /** Immutable config snapshot captured at fork time. */
    snapshot: jsonb("snapshot").$type<McpCatalogConfigSnapshot>().notNull(),
    /** sha256 of the canonical snapshot; suppresses no-op forks. */
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_catalog_versions_catalog_id_idx").on(table.catalogId),
    uniqueIndex("mcp_catalog_versions_catalog_version_uidx").on(
      table.catalogId,
      table.version,
    ),
  ],
);

export default internalMcpCatalogVersionsTable;
