import { and, eq, gt, lte, sql } from "drizzle-orm";
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

  /**
   * Cancel a task the caller owns, in one guarded statement.
   *
   * The principal match is the authorization: a task belonging to someone else
   * (or already terminal, or expired) reports false, which is also the caller's
   * signal that there was nothing to abort. Doing this as a single conditional
   * update rather than read-then-write means a concurrent completion cannot
   * slip between the check and the write.
   */
  static async cancelForPrincipal(params: {
    taskId: string;
    principal: string;
  }): Promise<boolean> {
    const updated = await db
      .update(schema.mcpGatewayTasksTable)
      .set({ status: "cancelled", updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.mcpGatewayTasksTable.id, params.taskId),
          eq(schema.mcpGatewayTasksTable.principal, params.principal),
          eq(schema.mcpGatewayTasksTable.status, "working"),
          gt(schema.mcpGatewayTasksTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: schema.mcpGatewayTasksTable.id });
    return updated.length > 0;
  }

  /**
   * Flip every expired `working` row to `failed`.
   *
   * The extension sanctions this explicitly: "servers MAY mark a task as
   * `failed` at any point after the TTL elapses". A row still `working` past
   * its expiry means the replica executing it died before writing an outcome
   * — reads already refuse expired rows either way, so this is about the row
   * telling the truth: a task whose executor is gone is a failed task, not a
   * running one. The `working` guard means a still-live execution that
   * settles concurrently wins exactly as it does against cancellation.
   * Idempotent and replica-safe; every backend pod may sweep.
   */
  static async failExpired(): Promise<number> {
    const updated = await db
      .update(schema.mcpGatewayTasksTable)
      .set({
        status: "failed",
        error: {
          code: -32603,
          message: "Task expired before it produced a result",
        },
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.mcpGatewayTasksTable.status, "working"),
          lte(schema.mcpGatewayTasksTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: schema.mcpGatewayTasksTable.id });
    return updated.length;
  }

  /**
   * Delete rows whose expiry is at least `graceMs` in the past.
   *
   * The extension's retention stance: after the TTL a server may "subsequently
   * delete it at any time", and answering not-found for a purged task is
   * compliant — which reads already do the moment a row expires. The grace
   * window exists purely for operators: recent outcomes stay inspectable in
   * the table for a while before the reaper removes them.
   */
  static async purgeExpired(params: { graceMs: number }): Promise<number> {
    const cutoff = new Date(Date.now() - params.graceMs);
    const deleted = await db
      .delete(schema.mcpGatewayTasksTable)
      .where(lte(schema.mcpGatewayTasksTable.expiresAt, cutoff))
      .returning({ id: schema.mcpGatewayTasksTable.id });
    return deleted.length;
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
