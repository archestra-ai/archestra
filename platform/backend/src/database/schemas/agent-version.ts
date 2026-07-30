import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentConfigSnapshot } from "@/types/agent-version";
import agentsTable from "./agent";

/**
 * Immutable snapshot of an agent's configuration (the agents-row scalars plus
 * the config child tables — see AgentConfigSnapshotSchema for the exact
 * surface). Every config write that changes the canonical payload forks a new
 * version (`version` increments per agent from 1); a write producing an
 * identical payload reuses the head. `agents.latest_version` points at the
 * head (0 = legacy row that predates versioning and has not been written to
 * since).
 *
 * Rows are never updated, only appended and aged out: a fork trims versions
 * below the retention window (see MAX_VERSIONS_PER_AGENT in the model), so
 * `version` numbers stay monotonic but the oldest are not kept forever.
 *
 * Unlike `app_versions`/`skill_versions`, `agent_id` is NOT NULL and ON DELETE
 * CASCADE: nothing pins an agent version (no sandbox-mount equivalent), so the
 * history of a hard-deleted agent has no consumer and is removed with it.
 */
const agentVersionsTable = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /** Per-agent version number, starting at 1. */
    version: integer("version").notNull(),
    /** Immutable config snapshot captured at fork time. */
    snapshot: jsonb("snapshot").$type<AgentConfigSnapshot>().notNull(),
    /** sha256 of the canonical snapshot; suppresses no-op forks. */
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_versions_agent_id_idx").on(table.agentId),
    uniqueIndex("agent_versions_agent_version_uidx").on(
      table.agentId,
      table.version,
    ),
  ],
);

export default agentVersionsTable;
