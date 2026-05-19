import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillFileKind } from "@/types/skill";
import skillsTable from "./skill";

/**
 * Bundled resource files for a skill — the `scripts/`, `references/`, and
 * `assets/` tier of the Agent Skills spec. One row per file.
 *
 * Files are stored as text; the model loads them on demand via the
 * `read_skill_file` tool. Binary assets are not supported.
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
    /** File contents (text only). */
    content: text("content").notNull(),
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
