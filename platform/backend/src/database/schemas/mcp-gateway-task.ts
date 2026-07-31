import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { McpGatewayTaskStatus } from "@/types/mcp-gateway-task";
import agentsTable from "./agent";

/**
 * Gateway-minted MCP tasks (Tasks extension, io.modelcontextprotocol/tasks).
 *
 * When a tool call from a task-capable client outlives the synchronous
 * threshold, the gateway durably creates a row here BEFORE answering with the
 * task handle — the spec's ordering — and the execution continues on the
 * replica that started it, writing its result into the row when it settles.
 * `tasks/get` and `tasks/cancel` read and update the row, so any replica can
 * serve them; only in-process cancellation of the running call is
 * origin-replica-local.
 */
const mcpGatewayTasksTable = pgTable(
  "mcp_gateway_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade: a deleted agent's tasks are unreachable anyway — the gateway
    // route 404s before task resolution — so keep no orphans.
    agentId: uuid("agent_id")
      .references(() => agentsTable.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * Caller the task belongs to, in the same `user:`/`token:`/`org:` form the
     * MRTR request-state binding uses. tasks/get and tasks/cancel resolve the
     * task only for this principal, and answer not-found otherwise, so one
     * caller can neither read nor cancel another's task.
     */
    principal: text("principal").notNull(),
    toolName: varchar("tool_name", { length: 512 }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<McpGatewayTaskStatus>()
      .notNull()
      .default("working"),
    /** Tool result, present once status is completed. */
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    /** JSON-RPC error shape, present once status is failed. */
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    /**
     * When the row stops being served. Doubles as the orphan bound: a replica
     * that dies mid-execution leaves the row `working`, and expiry is what
     * ends the client's polling instead of an answer that never comes.
     */
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_gateway_tasks_agent_principal_idx").on(
      table.agentId,
      table.principal,
    ),
    index("mcp_gateway_tasks_expires_at_idx").on(table.expiresAt),
  ],
);

export default mcpGatewayTasksTable;
