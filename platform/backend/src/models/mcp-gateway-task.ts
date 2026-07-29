import { and, eq, gt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  McpGatewayTask,
  McpGatewayTaskStatus,
} from "@/types/mcp-gateway-task";

/**
 * Gateway-minted MCP tasks (Tasks extension). Postgres is the source of truth
 * so any replica can serve `tasks/get`/`tasks/cancel`; the running execution
 * lives only on the replica that started it and writes its outcome here.
 */
export default class McpGatewayTaskModel {
  /**
   * Durably create the task row. The extension requires this to happen BEFORE
   * the task handle is sent to the client — a handle referencing a row that
   * does not exist yet could race the client's first poll.
   */
  static async create(params: {
    agentId: string;
    principal: string;
    toolName: string;
    ttlMs: number;
  }): Promise<McpGatewayTask> {
    const [row] = await db
      .insert(schema.mcpGatewayTasksTable)
      .values({
        agentId: params.agentId,
        principal: params.principal,
        toolName: params.toolName,
        status: "working",
        expiresAt: new Date(Date.now() + params.ttlMs),
      })
      .returning();
    return row;
  }

  /**
   * Resolve a task for the caller it belongs to. Another principal's task —
   * or an expired one — answers null, indistinguishable from a task that
   * never existed, so task ids do not leak across callers.
   */
  static async getForPrincipal(params: {
    taskId: string;
    agentId: string;
    principal: string;
  }): Promise<McpGatewayTask | null> {
    const [row] = await db
      .select()
      .from(schema.mcpGatewayTasksTable)
      .where(
        and(
          eq(schema.mcpGatewayTasksTable.id, params.taskId),
          eq(schema.mcpGatewayTasksTable.agentId, params.agentId),
          eq(schema.mcpGatewayTasksTable.principal, params.principal),
          gt(schema.mcpGatewayTasksTable.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Terminal transitions guard on `working` so they cannot overwrite each
   * other: a cancellation that landed first wins over the execution settling
   * later, and vice versa. Returns whether this call made the transition.
   */
  static async completeIfWorking(
    taskId: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    return McpGatewayTaskModel.transitionIfWorking(taskId, {
      status: "completed",
      result,
    });
  }

  static async failIfWorking(
    taskId: string,
    error: Record<string, unknown>,
  ): Promise<boolean> {
    return McpGatewayTaskModel.transitionIfWorking(taskId, {
      status: "failed",
      error,
    });
  }

  static async cancelIfWorking(taskId: string): Promise<boolean> {
    return McpGatewayTaskModel.transitionIfWorking(taskId, {
      status: "cancelled",
    });
  }

  private static async transitionIfWorking(
    taskId: string,
    changes: {
      status: McpGatewayTaskStatus;
      result?: Record<string, unknown>;
      error?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const updated = await db
      .update(schema.mcpGatewayTasksTable)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.mcpGatewayTasksTable.id, taskId),
          eq(schema.mcpGatewayTasksTable.status, "working"),
        ),
      )
      .returning({ id: schema.mcpGatewayTasksTable.id });
    return updated.length > 0;
  }
}
