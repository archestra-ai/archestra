import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import pluginsTable from "./plugin";

/**
 * Append-only snapshot of a plugin's files. Every write that changes the
 * files (an edit, an applied Git update, a restore) adds a version; `version`
 * counts up per plugin from 1. A write that leaves the files as they are adds
 * none.
 *
 * A plugin's name, description and other settings are columns of `plugins`
 * and are not versioned, as a skill's frontmatter is not.
 *
 * Versions go with their plugin: nothing else points at them, so permanently
 * deleting a plugin deletes its history (`ON DELETE CASCADE`). A deleted
 * plugin keeps it, and has it again when restored.
 */
const pluginVersionsTable = pgTable(
  "plugin_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    /** Per-plugin version number, starting at 1. */
    version: integer("version").notNull(),
    /** The plugin's `content_hash` for these files. */
    contentHash: text("content_hash").notNull(),
    /**
     * Git commit the files came from, for a version written by an import or
     * an applied update; null for an edit or a restore. Provenance only.
     */
    sourceCommit: text("source_commit"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("plugin_versions_plugin_id_idx").on(table.pluginId),
    uniqueIndex("plugin_versions_plugin_version_uidx").on(
      table.pluginId,
      table.version,
    ),
  ],
);

export default pluginVersionsTable;
