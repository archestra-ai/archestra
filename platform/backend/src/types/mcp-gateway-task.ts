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

export const SelectMcpGatewayTaskSchema = createSelectSchema(
  schema.mcpGatewayTasksTable,
);

export type McpGatewayTask = z.infer<typeof SelectMcpGatewayTaskSchema>;
