import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import skillSandboxesTable from "./skill-sandbox";
import skillVersionsTable from "./skill-version";

/**
 * One skill mounted into a sandbox at activation time. The mount pins an
 * immutable `skill_versions` row: replay reads the skill's bytes from that
 * version, so an edit to the live skill never changes an already-running
 * sandbox. A `skill_mount` replay event points at this row to fix *when* the
 * skill became visible in the ordered log.
 *
 * Exactly one mount per skill and per mount-path per sandbox (the two unique
 * constraints), so concurrent activations of the same skill cannot create
 * duplicate or hybrid skill directories. `skillId` is denormalized (not a FK):
 * it is the durable identity used by the revocation gate even after the source
 * skill is deleted.
 */
const skillSandboxSkillMountsTable = pgTable(
  "skill_sandbox_skill_mounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Durable skill identity for the revocation gate; intentionally not a FK. */
    skillId: uuid("skill_id").notNull(),
    /** Immutable version whose bytes this mount replays. */
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersionsTable.id, { onDelete: "restrict" }),
    /** Skill name at mount time, used to construct the mount path. */
    skillName: text("skill_name").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_skill_mounts_sandbox_id_idx").on(table.sandboxId),
    unique("skill_sandbox_skill_mounts_sandbox_skill_uidx").on(
      table.sandboxId,
      table.skillId,
    ),
    unique("skill_sandbox_skill_mounts_sandbox_name_uidx").on(
      table.sandboxId,
      table.skillName,
    ),
  ],
);

export default skillSandboxSkillMountsTable;
