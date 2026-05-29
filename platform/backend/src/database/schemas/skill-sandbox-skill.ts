import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import skillsTable from "./skill";
import skillSandboxesTable from "./skill-sandbox";

/**
 * Junction between a sandbox and the skills mounted into it at creation.
 * The recipe is immutable: the set of skills cannot be changed after the
 * sandbox is materialized.
 */
const skillSandboxSkillsTable = pgTable(
  "skill_sandbox_skills",
  {
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.sandboxId, table.skillId] })],
);

export default skillSandboxSkillsTable;
