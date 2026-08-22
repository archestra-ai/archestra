import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PluginFileEncoding, PluginFileMode } from "@/types/plugin";
import pluginsTable from "./plugin";

/** Opaque plugin payload files. The platform never parses hook semantics. */
const pluginFilesTable = pgTable(
  "plugin_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** UTF-8 text verbatim, or base64-encoded raw bytes. */
    content: text("content").notNull(),
    encoding: text("encoding")
      .$type<PluginFileEncoding>()
      .notNull()
      .default("utf8"),
    mode: text("mode").$type<PluginFileMode>().notNull().default("100644"),
    digest: text("digest").notNull(),
  },
  (table) => [
    index("plugin_files_plugin_id_idx").on(table.pluginId),
    uniqueIndex("plugin_files_plugin_path_uidx").on(table.pluginId, table.path),
  ],
);

export default pluginFilesTable;
