import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentExecution, AgentRun, InsertAgentRun } from "@/types";

/**
 * The Agent run carrying one A2A task. Holds no lifecycle state of its own — the
 * task's state machine is the record of how the work is going.
 */
class AgentRunModel {
  static async create(run: InsertAgentRun): Promise<AgentRun> {
    const [created] = await db
      .insert(schema.agentRunsTable)
      .values(run)
      .returning();
    return created;
  }

  static async findByTaskId(taskId: string): Promise<AgentRun | null> {
    const [run] = await db
      .select()
      .from(schema.agentRunsTable)
      .where(eq(schema.agentRunsTable.taskId, taskId))
      .limit(1);
    return run ?? null;
  }

  /** Sessions whose pod should still exist, across every organization. */
  static async listOpen(): Promise<AgentRun[]> {
    return db
      .select()
      .from(schema.agentRunsTable)
      .where(isNull(schema.agentRunsTable.endedAt));
  }

  static async listForAgent(params: {
    agentId: string;
    organizationId: string;
  }): Promise<AgentExecution[]> {
    const { logs: _logs, ...runColumns } = getTableColumns(
      schema.agentRunsTable,
    );
    return db
      .select({
        ...runColumns,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
      })
      .from(schema.agentRunsTable)
      .innerJoin(
        schema.a2aTasksTable,
        eq(schema.agentRunsTable.taskId, schema.a2aTasksTable.id),
      )
      .where(
        and(
          eq(schema.agentRunsTable.agentId, params.agentId),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.agentRunsTable.startedAt));
  }

  /**
   * Mark a session finished. Returns false when it was already closed, so a
   * caller racing the reconciler can tell whether it owns the teardown.
   */
  static async close(params: { id: string; logs?: string }): Promise<boolean> {
    const closed = await db
      .update(schema.agentRunsTable)
      .set({ endedAt: new Date(), logs: params.logs })
      .where(
        and(
          eq(schema.agentRunsTable.id, params.id),
          isNull(schema.agentRunsTable.endedAt),
        ),
      )
      .returning({ id: schema.agentRunsTable.id });
    return closed.length > 0;
  }

  static async clearVirtualApiKey(id: string): Promise<void> {
    await db
      .update(schema.agentRunsTable)
      .set({ virtualApiKeyId: null })
      .where(eq(schema.agentRunsTable.id, id));
  }
}

export default AgentRunModel;
