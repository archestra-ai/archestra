import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  A2aOutboundRunState,
  A2aSelectedInterface,
} from "@/types/a2a-outbound";
import a2aConnectionsTable from "./a2a-connection";
import a2aRemoteAgentsTable from "./a2a-remote-agent";
import agentsTable from "./agent";
import conversationsTable from "./conversation";
import mcpToolCallsTable from "./mcp-tool-call";
import organizationsTable from "./organization";
import toolsTable from "./tool";
import usersTable from "./user";

/**
 * Local execution envelope for one outbound delegation call. Remote task and
 * context identifiers remain opaque strings and are always scoped by the
 * connection that issued the call.
 */
const a2aOutboundRunsTable = pgTable(
  "a2a_outbound_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    parentAgentId: uuid("parent_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    remoteAgentId: uuid("remote_agent_id").references(
      () => a2aRemoteAgentsTable.id,
      { onDelete: "set null" },
    ),
    connectionId: uuid("connection_id").references(
      () => a2aConnectionsTable.id,
      { onDelete: "set null" },
    ),
    toolId: uuid("tool_id").references(() => toolsTable.id, {
      onDelete: "set null",
    }),
    mcpToolCallId: uuid("mcp_tool_call_id").references(
      () => mcpToolCallsTable.id,
      { onDelete: "set null" },
    ),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    toolCallId: text("tool_call_id"),
    messageId: text("message_id").notNull(),
    remoteTaskId: text("remote_task_id"),
    remoteContextId: text("remote_context_id"),
    state: text("state").$type<A2aOutboundRunState>().notNull(),
    targetNameSnapshot: text("target_name_snapshot").notNull(),
    interfaceSnapshot: jsonb("interface_snapshot")
      .$type<A2aSelectedInterface>()
      .notNull(),
    errorCode: text("error_code"),
    statusReason: text("status_reason"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_outbound_runs_organization_id_idx").on(table.organizationId),
    index("a2a_outbound_runs_parent_agent_id_idx").on(table.parentAgentId),
    index("a2a_outbound_runs_connection_task_idx").on(
      table.connectionId,
      table.remoteTaskId,
    ),
    index("a2a_outbound_runs_created_at_idx").on(table.createdAt),
  ],
);

export default a2aOutboundRunsTable;
