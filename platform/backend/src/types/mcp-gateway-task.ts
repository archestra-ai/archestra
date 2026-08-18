import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Status of a gateway-minted MCP task (Tasks extension,
 * `io.modelcontextprotocol/tasks`).
 *
 * `input_required` exists in the extension but the gateway never emits it in
 * this version: a tasked execution runs detached from any client stream, so an
 * upstream elicitation mid-task has no one to ask and fails the task instead.
 */
export const McpGatewayTaskStatusSchema = z.enum([
  "working",
  "completed",
  "failed",
  "cancelled",
]);

export type McpGatewayTaskStatus = z.infer<typeof McpGatewayTaskStatusSchema>;

/**
 * Harness context stamped on tasks spawned from a chat conversation (background
 * delegations). Everything a settle — on ANY replica, including the reaper —
 * needs to compose the wake notification lives here or on the row's own
 * columns, so delivery never depends on in-process closures.
 */
export const McpGatewayTaskContextSchema = z.object({
  kind: z.enum(["delegation", "skill"]),
  /** Display name of the delegated-to agent (or skill), for the notification. */
  targetAgentName: z.string(),
});

export type McpGatewayTaskContext = z.infer<typeof McpGatewayTaskContextSchema>;

export const SelectMcpGatewayTaskSchema = createSelectSchema(
  schema.mcpGatewayTasksTable,
).extend({
  // drizzle-zod types jsonb columns loosely; pin the harness context shape.
  context: McpGatewayTaskContextSchema.nullable(),
});

export type McpGatewayTask = z.infer<typeof SelectMcpGatewayTaskSchema>;
