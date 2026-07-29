import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResourceUserAccessLevel } from "@/types/resource-user-level";
import agentsTable from "./agent";
import usersTable from "./user";

/**
 * Individually-named users a agent is shared with — the per-person
 * counterpart to `agent_team`. An agent built for one colleague had no way to reach them without
 * publishing it to a whole team or the organization.
 *
 * The grant is additive to the `personal` scope rather than a scope of its own:
 * `agents.scope` is shared with every other scoped resource, so adding a fourth
 * value would hand a scope to code that cannot honour it.
 */
const agentUsersTable = pgTable(
  "agent_user",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Defaults to `use`: per-user sharing is new here, so it starts at least
    // privilege — reach the agent, not rewrite it.
    level: text("level")
      .$type<ResourceUserAccessLevel>()
      .notNull()
      .default("use"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.userId] }),
    // The API serializes `level` through a strict enum, so a value outside
    // `use`/`write` would fail response validation. Enforce it in the database
    // too, matching the catalog grant table.
    levelCheck: check(
      "agent_user_level_check",
      sql`
      ${table.level} in ('use', 'write')`,
    ),
  }),
);

export default agentUsersTable;
