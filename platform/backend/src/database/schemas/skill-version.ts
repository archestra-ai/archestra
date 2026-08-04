import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import skillsTable from "./skill";

/**
 * Append-only immutable snapshot of a skill's SKILL.md body. Every edit that
 * changes the canonical payload (body + resource files) forks a new version
 * (`version` increments per skill from 1); an edit that produces an identical
 * payload reuses the latest version. `skills.latest_version` points at the head.
 *
 * Sandboxes pin a specific version at mount time, so a skill edited mid-
 * conversation never mutates an already-running sandbox: the sandbox keeps
 * replaying the bytes it was activated with.
 *
 * `skill_id` is nullable and `ON DELETE SET NULL`: when the source skill is
 * deleted, its version bytes survive for sandboxes that still reference them
 * (`skill_sandbox_skill_mounts.skill_version_id` is `ON DELETE RESTRICT`).
 */
const skillVersionsTable = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id").references(() => skillsTable.id, {
      onDelete: "set null",
    }),
    /** Per-skill version number, starting at 1. */
    version: integer("version").notNull(),
    /** Immutable SKILL.md body captured at fork time. */
    content: text("content").notNull(),
    /** sha256 of the canonical payload (body + files); used to suppress no-op forks. */
    contentHash: text("content_hash").notNull(),
    /**
     * Git commit the bytes came from, for versions forked by a GitHub import or
     * a scheduled sync; null for everything else (authored edits, restores,
     * built-in skills). Provenance only — nothing reads it to resolve content,
     * and it is deliberately not set from `skills.source_commit`, which
     * built-in skills fill with a content hash rather than a commit.
     *
     * The repo and skill path needed to build a link live on the skill's
     * `source_ref`, so a version whose skill was deleted keeps a SHA that can
     * no longer be resolved to a URL. Acceptable: the link is informational.
     */
    sourceCommit: text("source_commit"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_versions_skill_id_idx").on(table.skillId),
    uniqueIndex("skill_versions_skill_version_uidx").on(
      table.skillId,
      table.version,
    ),
  ],
);

export default skillVersionsTable;
