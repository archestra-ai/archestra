import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SkillFileEncoding } from "@/types/skill";
import skillSandboxesTable from "./skill-sandbox";

/**
 * Immutable snapshot of a skill's files captured at sandbox creation time.
 * One row per file per skill per sandbox (SKILL.md is stored at path "SKILL.md").
 * Using snapshotted content rather than live skill rows ensures sandbox replay
 * is deterministic even if the source skill is later updated or deleted.
 */
const skillSandboxFileSnapshotsTable = pgTable(
  "skill_sandbox_file_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
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
  ],
);

export default skillSandboxFileSnapshotsTable;
