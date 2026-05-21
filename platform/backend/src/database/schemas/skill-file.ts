import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillFileEncoding, SkillFileKind } from "@/types/skill";
import skillsTable from "./skill";

/**
 * Bundled resource files for a skill — the `scripts/`, `references/`, and
 * `assets/` tier of the Agent Skills spec. One row per file.
 *
 * `content` is always stored as text. UTF-8 files are stored verbatim; binary
 * assets are base64-encoded so we can faithfully redistribute whole skills.
 * Consumers must check `encoding` before treating `content` as text.
 */
const skillFilesTable = pgTable(
  "skill_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    /** Path relative to the skill root, e.g. `references/REFERENCE.md`. */
    path: text("path").notNull(),
    /** File contents — UTF-8 text or base64-encoded bytes (see `encoding`). */
    content: text("content").notNull(),
    /** "utf8" for text files; "base64" for binary assets. */
    encoding: text("encoding")
      .$type<SkillFileEncoding>()
      .notNull()
      .default("utf8"),
    /** Coarse classification derived from the path. */
    kind: text("kind").$type<SkillFileKind>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_files_skill_id_idx").on(table.skillId),
    uniqueIndex("skill_files_skill_path_idx").on(table.skillId, table.path),
  ],
);

export default skillFilesTable;
