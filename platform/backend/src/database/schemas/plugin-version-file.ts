import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PluginFileEncoding, PluginFileMode } from "@/types/plugin";
import pluginVersionsTable from "./plugin-version";

/**
 * The files of one `plugin_versions` row: the frozen counterpart of
 * `plugin_files`, column for column. Each version holds its whole file set,
 * so a later edit cannot change what an earlier version held.
 */
const pluginVersionFilesTable = pgTable(
  "plugin_version_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => pluginVersionsTable.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** UTF-8 text verbatim, or base64-encoded raw bytes. */
    content: text("content").notNull(),
    encoding: text("encoding").$type<PluginFileEncoding>().notNull(),
    mode: text("mode").$type<PluginFileMode>().notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    index("plugin_version_files_version_id_idx").on(table.versionId),
    uniqueIndex("plugin_version_files_version_path_uidx").on(
      table.versionId,
      table.path,
    ),
  ],
);

export default pluginVersionFilesTable;
