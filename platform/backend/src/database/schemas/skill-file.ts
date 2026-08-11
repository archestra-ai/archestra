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
    /**
     * `sha256:<hex>` over the file's *raw* bytes (base64 `content` decoded
     * first), served as the per-file integrity digest when the skill is
     * published over MCP (SEP-2640).
     *
     * APPLICATION-OWNED: `computeFileDigest` is the single producer, written
     * by the model layer alongside the bytes it covers. The database only
     * guards staleness — the `skill_files_invalidate_digest` BEFORE UPDATE
     * trigger (migration 0407) nulls the digest when a write moves
     * `content`/`encoding` without refreshing it. A null digest means the row
     * predates migration 0407 or was written outside the model layer; such a
     * file is withheld from publication until the startup backfill
     * (services/skill-publication-backfill.ts) or the next model write
     * restores it.
     *
     * Triggers are invisible in a Drizzle schema; see the migration before
     * assuming this column is inert.
     */
    digest: text("digest"),
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
