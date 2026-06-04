import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SkillFileEncoding } from "@/types/skill";
import skillSandboxesTable from "./skill-sandbox";
import skillSandboxSkillMountsTable from "./skill-sandbox-skill-mount";

/**
 * Immutable snapshot of a skill's files captured at mount (activation) time.
 * One row per file per mount (SKILL.md is stored at path "SKILL.md"). Using
 * snapshotted content rather than live skill rows ensures sandbox replay is
 * deterministic even if the source skill is later updated or deleted.
 *
 * Rows are grouped by `skillMountId`: a `skill_mount` replay event references
 * the mount, and replay serializes that mount's snapshot rows into the
 * container at the event's sequence point.
 */
const skillSandboxFileSnapshotsTable = pgTable(
  "skill_sandbox_file_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Mount these bytes belong to; the ordered `skill_mount` event groups them. */
    skillMountId: uuid("skill_mount_id")
      .notNull()
      .references(() => skillSandboxSkillMountsTable.id, {
        onDelete: "cascade",
      }),
    /** Denormalized owning org, copied from the parent sandbox at insert time. */
    organizationId: text("organization_id").notNull(),
    /** Original skill id — kept for reference but not used for replay. */
    skillId: uuid("skill_id").notNull(),
    /** Skill name at capture time, used to construct the mount path. */
    skillName: text("skill_name").notNull(),
    /** Path relative to the skill root, e.g. "SKILL.md" or "scripts/run.py". */
    path: text("path").notNull(),
    /** "utf8" for text files; "base64" for binary assets. */
    encoding: text("encoding").$type<SkillFileEncoding>().notNull(),
    /** File contents — UTF-8 text or base64-encoded bytes (see `encoding`). */
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_file_snapshots_sandbox_id_idx").on(table.sandboxId),
    index("skill_sandbox_file_snapshots_skill_mount_id_idx").on(
      table.skillMountId,
    ),
  ],
);

export default skillSandboxFileSnapshotsTable;
