import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import conversationsTable from "./conversation";
import skillsTable from "./skill";
import usersTable from "./user";

/**
 * Skill execution sandbox: durable recipe for a Dagger-materialized container
 * that runs commands against a snapshot of selected skill files.
 *
 * Postgres is the source of truth for the recipe (this row + junction +
 * command log + artifacts). Dagger owns filesystem state and has no retention
 * guarantees — sandboxes are replayed from the command log when the cache is
 * cold.
 */
const skillSandboxesTable = pgTable(
  "skill_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Conversation the sandbox was created from, when known. */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    /** Agent that created the sandbox, when known. */
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    /** Container image identifier. Admin-configurable; see runtime-image.ts. */
    baseImage: text("base_image").notNull(),
    /**
     * Primary skill the sandbox was created for. Determines `defaultCwd` and
     * sets the canonical skill root for relative paths in commands.
     */
    primarySkillId: uuid("primary_skill_id").references(() => skillsTable.id, {
      onDelete: "set null",
    }),
    /** Working directory used when a command does not provide an explicit cwd. */
    defaultCwd: text("default_cwd").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandboxes_organization_id_idx").on(table.organizationId),
    index("skill_sandboxes_user_id_idx").on(table.userId),
    index("skill_sandboxes_conversation_id_idx").on(table.conversationId),
  ],
);

export default skillSandboxesTable;
