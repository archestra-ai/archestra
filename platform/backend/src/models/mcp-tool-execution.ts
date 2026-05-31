import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { McpToolExecutionStatus } from "@/database/schemas/mcp-tool-execution";
import type { CommonToolCall, CommonToolResult } from "@/types";

const TOOL_EXECUTION_POLL_INTERVAL_MS = 100;
const TOOL_EXECUTION_WAIT_TIMEOUT_MS = 30_000;

type McpToolExecution = typeof schema.mcpToolExecutionsTable.$inferSelect;

type ClaimResult =
  | { kind: "claimed"; execution: McpToolExecution }
  | { kind: "completed"; result: CommonToolResult }
  | { kind: "failed"; result: CommonToolResult }
  | { kind: "in_progress"; execution: McpToolExecution | null };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: McpToolExecutionStatus) {
  return status === "completed" || status === "failed";
}

function buildStoredResult(execution: McpToolExecution): CommonToolResult {
  if (execution.toolResult) {
    return execution.toolResult;
  }

  const error =
    execution.error ??
    "This approved tool call already finished, but no tool result was recorded.";

  return {
    id: execution.toolCallId,
    name: execution.toolName,
    content: [{ type: "text", text: error }],
    isError: true,
    error,
  };
}

class McpToolExecutionModel {
  static async claim(params: {
    toolCallId: string;
    agentId: string;
    conversationId?: string;
    userId: string;
    toolName: string;
    toolCall: CommonToolCall;
  }): Promise<ClaimResult> {
    const [execution] = await db
      .insert(schema.mcpToolExecutionsTable)
      .values({
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        conversationId: params.conversationId ?? null,
        userId: params.userId,
        toolName: params.toolName,
        toolCall: params.toolCall,
        status: "executing",
      })
      .onConflictDoNothing()
      .returning();

    if (execution) {
      return { kind: "claimed", execution };
    }

    return McpToolExecutionModel.waitForTerminalResult(params.toolCallId);
  }

  static async markCompleted(params: {
    toolCallId: string;
    result: CommonToolResult;
  }): Promise<void> {
    await db
      .update(schema.mcpToolExecutionsTable)
      .set({
        status: "completed",
        toolResult: params.result,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.mcpToolExecutionsTable.toolCallId, params.toolCallId));
  }

  static async markFailed(params: {
    toolCallId: string;
    result: CommonToolResult;
    error: string;
  }): Promise<void> {
    await db
      .update(schema.mcpToolExecutionsTable)
      .set({
        status: "failed",
        toolResult: params.result,
        error: params.error,
        updatedAt: new Date(),
      })
      .where(eq(schema.mcpToolExecutionsTable.toolCallId, params.toolCallId));
  }

  private static async waitForTerminalResult(
    toolCallId: string,
  ): Promise<ClaimResult> {
    const deadline = Date.now() + TOOL_EXECUTION_WAIT_TIMEOUT_MS;
    let lastExecution: McpToolExecution | null = null;

    while (Date.now() <= deadline) {
      const execution =
        await McpToolExecutionModel.findByToolCallId(toolCallId);
      lastExecution = execution;

      if (!execution) {
        return { kind: "in_progress", execution: null };
      }

      if (isTerminalStatus(execution.status)) {
        return {
          kind: execution.status === "completed" ? "completed" : "failed",
          result: buildStoredResult(execution),
        };
      }

      await sleep(TOOL_EXECUTION_POLL_INTERVAL_MS);
    }

    return { kind: "in_progress", execution: lastExecution };
  }

  private static async findByToolCallId(
    toolCallId: string,
  ): Promise<McpToolExecution | null> {
    const [execution] = await db
      .select()
      .from(schema.mcpToolExecutionsTable)
      .where(eq(schema.mcpToolExecutionsTable.toolCallId, toolCallId))
      .limit(1);

    return execution ?? null;
  }
}

export default McpToolExecutionModel;
