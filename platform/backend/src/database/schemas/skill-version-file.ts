import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillFileEncoding, SkillFileKind } from "@/types/skill";
import skillVersionsTable from "./skill-version";

/**
 * Immutable resource files belonging to one `skill_versions` row — the frozen
 * counterpart of `skill_files`. One row per file; `content` is UTF-8 text or
 * base64-encoded bytes per `encoding`, identical to `skill_files`. No byte
 * sharing across versions: each fork copies the full file set, so a version's
 * bytes can never be mutated by a later edit.
 */
const skillVersionFilesTable = pgTable(
  "skill_version_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => skillVersionsTable.id, { onDelete: "cascade" }),
    /** Path relative to the skill root, e.g. `references/REFERENCE.md`. */
    path: text("path").notNull(),
    /** File contents — UTF-8 text or base64-encoded bytes (see `encoding`). */
    content: text("content").notNull(),
    /** "utf8" for text files; "base64" for binary assets. */
    encoding: text("encoding").$type<SkillFileEncoding>().notNull(),
    /** Coarse classification derived from the path. */
    kind: text("kind").$type<SkillFileKind>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_version_files_version_id_idx").on(table.versionId),
    uniqueIndex("skill_version_files_version_path_uidx").on(
      table.versionId,
      table.path,
    ),
  ],
);

export default skillVersionFilesTable;
