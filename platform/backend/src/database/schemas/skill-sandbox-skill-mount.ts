import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import skillSandboxesTable from "./skill-sandbox";

/**
 * One skill mounted into a sandbox at activation time. This is the grouping a
 * `skill_mount` replay event points at: the ordered event fixes *when* the
 * skill became visible, while the file snapshots that carry the skill's bytes
 * reference this row to record *which* mount they belong to.
 *
 * Skills are no longer fixed at sandbox creation — activating a skill appends a
 * new mount, so a sandbox accumulates mounts over the conversation.
 */
const skillSandboxSkillMountsTable = pgTable(
  "skill_sandbox_skill_mounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Denormalized owning org, copied from the parent sandbox at insert time. */
    organizationId: text("organization_id").notNull(),
    /** Original skill id — kept for reference but not used for replay. */
    skillId: uuid("skill_id").notNull(),
    /** Skill name at mount time, used to construct the mount path. */
    skillName: text("skill_name").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_skill_mounts_sandbox_id_idx").on(table.sandboxId),
  ],
);

export default skillSandboxSkillMountsTable;
