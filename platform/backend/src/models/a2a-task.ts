import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type {
  A2AProtocolPart,
  A2AProtocolStreamResponse,
} from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import type {
  A2AMessage,
  A2ATask,
  A2ATaskState,
  InsertA2AMessage,
  InsertA2ATask,
  InsertA2ATaskApprovalRequest,
} from "@/types";

/** States that may hold a live run (heartbeats, delta appends, reaping). */
const ACTIVE_RUN_STATES: A2ATaskState[] = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
];

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

class A2ATaskModel {
  static async create(data: InsertA2ATask): Promise<A2ATask> {
    const [task] = await db
      .insert(schema.a2aTasksTable)
      .values({ ...data, stateChangedAt: data.stateChangedAt ?? new Date() })
      .returning();

    await A2ATaskModel.touchContext(data.contextId);

    return task;
  }

  /**
   * T1: durably create the task (SUBMITTED) and attach the triggering user
   * message to it, atomically, BEFORE any execution starts — so the task id
   * handed to the client always resolves.
   */
  static async createForRun(params: {
    contextId: string;
    agentId: string;
    userMessageId?: string;
  }): Promise<A2ATask> {
    const now = new Date();
    const task = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.a2aTasksTable)
        .values({
          contextId: params.contextId,
          agentId: params.agentId,
          state: "TASK_STATE_SUBMITTED",
          stateChangedAt: now,
          lastHeartbeatAt: now,
        })
        .returning();

      if (params.userMessageId) {
        await tx
          .update(schema.a2aMessagesTable)
          .set({ taskId: created.id, updatedAt: now })
          .where(eq(schema.a2aMessagesTable.id, params.userMessageId));
      }

      return created;
    });

    await A2ATaskModel.touchContext(params.contextId);

    return task;
  }

  /**
   * Compare-and-set state transition plus its stream event, in one
   * transaction. Returns null (and writes nothing) when the task is no longer
   * in an allowed source state — the loser of a transition race must treat
   * that as "someone else owns the outcome".
   *
   * Because a terminal event commits atomically with its terminal state, a
   * subscriber that observes a terminal state has necessarily been offered
   * every event of the task (see a2a-task-event schema).
   */
  static async transitionStateWithEvent(params: {
    id: string;
    to: A2ATaskState;
    allowedFrom: A2ATaskState[];
    eventPayload: A2AProtocolStreamResponse;
    statusReason?: string;
    /** Also delete the task's approval-request rows (cancellation). */
    clearApprovals?: boolean;
  }): Promise<A2ATask | null> {
    return await db.transaction(async (tx) => {
      const task = await A2ATaskModel.transitionInTx(tx, params);
      if (!task) {
        return null;
      }

      if (params.clearApprovals) {
        await tx
          .delete(schema.a2aTaskApprovalRequestsTable)
          .where(eq(schema.a2aTaskApprovalRequestsTable.taskId, params.id));
      }

      await A2ATaskModel.appendEventInTx(tx, params.id, params.eventPayload);

      return task;
    });
  }

  /**
   * T3: append one run delta — allocate the next event seq (guarded on an
   * active state, so a cross-pod cancellation or reap surfaces here as null,
   * telling the run to stop), insert the stream event, and mirror the delta
   * into the task's artifact row so a later Task snapshot reconstructs every
   * chunk already emitted. The first delta of a run creates the artifact with
   * its first non-empty part; subsequent deltas extend the text of the first
   * part. Doubles as the run's heartbeat.
   */
  static async appendRunDelta(params: {
    taskId: string;
    eventPayload: A2AProtocolStreamResponse;
    artifact?: {
      id: string;
      name: string;
      appendText: string;
    };
  }): Promise<{ seq: number } | null> {
    return await db.transaction(async (tx) => {
      const [allocated] = await tx
        .update(schema.a2aTasksTable)
        .set({
          nextEventSeq: sql`${schema.a2aTasksTable.nextEventSeq} + 1`,
          lastHeartbeatAt: new Date(),
        })
        .where(
          and(
            eq(schema.a2aTasksTable.id, params.taskId),
            inArray(schema.a2aTasksTable.state, ACTIVE_RUN_STATES),
          ),
        )
        .returning({ next: schema.a2aTasksTable.nextEventSeq });

      if (!allocated) {
        return null;
      }
      const seq = allocated.next - 1;

      await tx.insert(schema.a2aTaskEventsTable).values({
        taskId: params.taskId,
        seq,
        payload: params.eventPayload,
      });

      if (params.artifact) {
        await A2ATaskModel.appendArtifactTextInTx(tx, {
          taskId: params.taskId,
          ...params.artifact,
        });
      }

      return { seq };
    });
  }

  /**
   * T4: terminal success — persist the agent message, seal the artifact, and
   * CAS to COMPLETED with its terminal event, all in one transaction. Returns
   * null with nothing written when the CAS loses (e.g. a cancellation landed
   * while the run was finishing), so a canceled task can never carry
   * completed outputs.
   */
  static async completeRun(params: {
    taskId: string;
    agentMessage: InsertA2AMessage & { id?: string };
    artifact?: {
      id: string;
      name: string;
      parts: A2AProtocolPart[];
    };
    /** Appended in order (e.g. artifact seal, then terminal statusUpdate). */
    eventPayloads: A2AProtocolStreamResponse[];
  }): Promise<{ task: A2ATask; message: A2AMessage } | null> {
    const result = await db.transaction(async (tx) => {
      const task = await A2ATaskModel.transitionInTx(tx, {
        id: params.taskId,
        to: "TASK_STATE_COMPLETED",
        allowedFrom: ACTIVE_RUN_STATES,
      });
      if (!task) {
        return null;
      }

      // Upsert: an approval-resumed run finalizes the SAME message row the
      // interrupt persisted (the UI message continues across the approval), so
      // completion must update it in place rather than colliding on the pkey.
      const [message] = await tx
        .insert(schema.a2aMessagesTable)
        .values({ ...params.agentMessage, taskId: params.taskId })
        .onConflictDoUpdate({
          target: schema.a2aMessagesTable.id,
          set: {
            content: params.agentMessage.content,
            parts: params.agentMessage.parts,
            taskId: params.taskId,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (params.artifact) {
        await tx
          .insert(schema.a2aArtifactsTable)
          .values({
            id: params.artifact.id,
            taskId: params.taskId,
            name: params.artifact.name,
            parts: params.artifact.parts,
          })
          .onConflictDoUpdate({
            target: schema.a2aArtifactsTable.id,
            set: { parts: params.artifact.parts, updatedAt: new Date() },
          });
      }

      for (const payload of params.eventPayloads) {
        await A2ATaskModel.appendEventInTx(tx, params.taskId, payload);
      }

      return { task, message };
    });

    if (result) {
      await A2ATaskModel.touchContext(result.task.contextId);
    }

    return result;
  }

  /**
   * T6: interrupt for tool approval — CAS WORKING → INPUT_REQUIRED, persist
   * the agent message that asked for approval plus the approval-request rows,
   * and append the input-required event, all atomically.
   */
  static async interruptForApproval(params: {
    taskId: string;
    agentMessage?: InsertA2AMessage & { id?: string };
    approvalRequests: InsertA2ATaskApprovalRequest[];
    eventPayload: A2AProtocolStreamResponse;
  }): Promise<A2ATask | null> {
    return await db.transaction(async (tx) => {
      const task = await A2ATaskModel.transitionInTx(tx, {
        id: params.taskId,
        to: "TASK_STATE_INPUT_REQUIRED",
        allowedFrom: ["TASK_STATE_WORKING"],
      });
      if (!task) {
        return null;
      }

      if (params.agentMessage) {
        await tx
          .insert(schema.a2aMessagesTable)
          .values({ ...params.agentMessage, taskId: params.taskId })
          .onConflictDoUpdate({
            target: schema.a2aMessagesTable.id,
            set: {
              content: params.agentMessage.content,
              parts: params.agentMessage.parts,
              taskId: params.taskId,
              updatedAt: new Date(),
            },
          });
      }

      if (params.approvalRequests.length > 0) {
        await tx
          .insert(schema.a2aTaskApprovalRequestsTable)
          .values(params.approvalRequests);
      }

      await A2ATaskModel.appendEventInTx(
        tx,
        params.taskId,
        params.eventPayload,
      );

      return task;
    });
  }

  /**
   * Apply approval decisions that do NOT yet resume the task (some requests
   * are still pending): the updated approval UI message and the approval-row
   * resolutions commit together.
   */
  static async applyApprovalDecisions(params: {
    taskId: string;
    lastMessage: { id: string; content: unknown };
    approvalDecisions: { approvalId: string; approved: boolean }[];
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.a2aMessagesTable)
        .set({ content: params.lastMessage.content, updatedAt: new Date() })
        .where(eq(schema.a2aMessagesTable.id, params.lastMessage.id));

      for (const decision of params.approvalDecisions) {
        await tx
          .update(schema.a2aTaskApprovalRequestsTable)
          .set({ approved: decision.approved, resolved: true })
          .where(
            and(
              eq(schema.a2aTaskApprovalRequestsTable.taskId, params.taskId),
              eq(
                schema.a2aTaskApprovalRequestsTable.approvalId,
                decision.approvalId,
              ),
            ),
          );
      }
    });
  }

  /**
   * Resume an approval task whose last pending decisions just resolved: CAS
   * INPUT_REQUIRED → WORKING first (a concurrent duplicate resume or
   * cancellation makes this return null with nothing written), then commit
   * the decision-bearing message update, approval-row cleanup, and the
   * Working event together.
   */
  static async resumeApprovedTask(params: {
    taskId: string;
    /** The approval UI message with every decision already applied to it. */
    lastMessage: { id: string; content: unknown };
    eventPayload: A2AProtocolStreamResponse;
  }): Promise<A2ATask | null> {
    return await db.transaction(async (tx) => {
      const task = await A2ATaskModel.transitionInTx(tx, {
        id: params.taskId,
        to: "TASK_STATE_WORKING",
        allowedFrom: ["TASK_STATE_INPUT_REQUIRED"],
      });
      if (!task) {
        return null;
      }

      await tx
        .update(schema.a2aMessagesTable)
        .set({ content: params.lastMessage.content, updatedAt: new Date() })
        .where(eq(schema.a2aMessagesTable.id, params.lastMessage.id));

      // The task is leaving the approval flow; the rows served their purpose
      // (their final approved/rejected values live on in the UI message).
      await tx
        .delete(schema.a2aTaskApprovalRequestsTable)
        .where(eq(schema.a2aTaskApprovalRequestsTable.taskId, params.taskId));

      await A2ATaskModel.appendEventInTx(
        tx,
        params.taskId,
        params.eventPayload,
      );

      return task;
    });
  }

  /**
   * Liveness heartbeat for a task with a live run. A no-op once the task left
   * the active states, so a delayed timer can never resurrect a settled task.
   */
  static async touchHeartbeat(id: string): Promise<void> {
    await db
      .update(schema.a2aTasksTable)
      .set({ lastHeartbeatAt: new Date() })
      .where(
        and(
          eq(schema.a2aTasksTable.id, id),
          inArray(schema.a2aTasksTable.state, ACTIVE_RUN_STATES),
        ),
      );
  }

  /**
   * Reap orphans: tasks claiming a live run (SUBMITTED/WORKING) whose
   * heartbeat went stale — their pod died without a graceful shutdown. Each
   * becomes FAILED with a terminal event, one task per transaction (rare
   * path). INPUT_REQUIRED tasks are waiting on a human, not a run, and are
   * never reaped.
   */
  static async reapStaleRunning(params: {
    staleMs: number;
    statusReason: string;
    buildEventPayload: (task: A2ATask) => A2AProtocolStreamResponse;
  }): Promise<number> {
    const cutoff = new Date(Date.now() - params.staleMs);
    const stale = await db
      .select()
      .from(schema.a2aTasksTable)
      .where(
        and(
          inArray(schema.a2aTasksTable.state, ACTIVE_RUN_STATES),
          or(
            isNull(schema.a2aTasksTable.lastHeartbeatAt),
            lt(schema.a2aTasksTable.lastHeartbeatAt, cutoff),
          ),
          // Legacy rows without heartbeats: fall back to row age.
          or(
            sql`${schema.a2aTasksTable.lastHeartbeatAt} IS NOT NULL`,
            lt(schema.a2aTasksTable.createdAt, cutoff),
          ),
        ),
      );

    let reaped = 0;
    for (const task of stale) {
      const transitioned = await A2ATaskModel.transitionStateWithEvent({
        id: task.id,
        to: "TASK_STATE_FAILED",
        allowedFrom: ACTIVE_RUN_STATES,
        statusReason: params.statusReason,
        eventPayload: params.buildEventPayload(task),
      });
      if (transitioned) {
        reaped += 1;
      }
    }

    return reaped;
  }

  /**
   * Read the task row and its events after `afterSeq`, ordered by seq. The
   * task is read FIRST: if it shows a terminal state, the terminal event
   * already committed (same transaction as the transition), so the events
   * read — taken after the state read — cannot miss it. A non-terminal state
   * just means the next poll picks up whatever lands later.
   */
  static async readTaskAndEventsAfter(params: {
    taskId: string;
    afterSeq: number;
  }): Promise<{
    task: A2ATask;
    events: { seq: number; payload: A2AProtocolStreamResponse }[];
  } | null> {
    const task = await A2ATaskModel.findById(params.taskId);
    if (!task) {
      return null;
    }

    const events = await db
      .select({
        seq: schema.a2aTaskEventsTable.seq,
        payload: schema.a2aTaskEventsTable.payload,
      })
      .from(schema.a2aTaskEventsTable)
      .where(
        and(
          eq(schema.a2aTaskEventsTable.taskId, params.taskId),
          sql`${schema.a2aTaskEventsTable.seq} > ${params.afterSeq}`,
        ),
      )
      .orderBy(schema.a2aTaskEventsTable.seq);

    return { task, events };
  }

  /**
   * ListTasks page for one actor + agent. Ordered by status-change time
   * (falling back to createdAt for pre-migration rows) descending, id
   * descending as the tiebreaker; the cursor is that same (timestamp, id)
   * pair, so heartbeats and message appends can never destabilize pagination.
   * Legacy tasks without an agent binding belong to whichever agent the
   * actor reaches them through, so `agentId IS NULL` rows are included.
   */
  static async listForActor(params: {
    actorKind: string;
    actorId: string;
    agentId: string;
    contextId?: string;
    state?: A2ATaskState;
    statusChangedAfter?: Date;
    cursor?: { stateChangedAt: Date; id: string };
    pageSize: number;
  }): Promise<{ tasks: A2ATask[]; totalSize: number }> {
    const orderingTimestamp = sql`COALESCE(${schema.a2aTasksTable.stateChangedAt}, ${schema.a2aTasksTable.createdAt})`;

    const filters = and(
      eq(schema.a2aContextsTable.actorKind, params.actorKind),
      eq(schema.a2aContextsTable.actorId, params.actorId),
      or(
        eq(schema.a2aTasksTable.agentId, params.agentId),
        isNull(schema.a2aTasksTable.agentId),
      ),
      params.contextId
        ? eq(schema.a2aTasksTable.contextId, params.contextId)
        : undefined,
      params.state ? eq(schema.a2aTasksTable.state, params.state) : undefined,
      params.statusChangedAfter
        ? sql`${orderingTimestamp} > ${params.statusChangedAfter}`
        : undefined,
    );

    const base = db
      .select({ task: schema.a2aTasksTable })
      .from(schema.a2aTasksTable)
      .innerJoin(
        schema.a2aContextsTable,
        eq(schema.a2aTasksTable.contextId, schema.a2aContextsTable.id),
      );

    const rows = await base
      .where(
        and(
          filters,
          params.cursor
            ? sql`(${orderingTimestamp}, ${schema.a2aTasksTable.id}) < (${params.cursor.stateChangedAt}, ${params.cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(orderingTimestamp), desc(schema.a2aTasksTable.id))
      .limit(params.pageSize);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.a2aTasksTable)
      .innerJoin(
        schema.a2aContextsTable,
        eq(schema.a2aTasksTable.contextId, schema.a2aContextsTable.id),
      )
      .where(filters);

    return {
      tasks: rows.map((row) => row.task),
      totalSize: Number(count),
    };
  }

  /** Graceful-shutdown path: fail this pod's still-active tasks. */
  static async failActiveByIds(params: {
    ids: string[];
    statusReason: string;
    buildEventPayload: (task: A2ATask) => A2AProtocolStreamResponse;
  }): Promise<number> {
    let failed = 0;
    for (const id of params.ids) {
      const task = await A2ATaskModel.findById(id);
      if (!task) {
        continue;
      }
      const transitioned = await A2ATaskModel.transitionStateWithEvent({
        id,
        to: "TASK_STATE_FAILED",
        allowedFrom: ACTIVE_RUN_STATES,
        statusReason: params.statusReason,
        eventPayload: params.buildEventPayload(task),
      });
      if (transitioned) {
        failed += 1;
      }
    }
    return failed;
  }

  /**
   * Stream events are subscription transport, not the record: once a task has
   * been terminal for longer than the retention window nothing can subscribe
   * to it (-32004), so its events are dead weight and get deleted.
   */
  static async deleteEventsOfTerminalTasksOlderThan(
    retentionMs: number,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - retentionMs);
    await db.delete(schema.a2aTaskEventsTable).where(
      inArray(
        schema.a2aTaskEventsTable.taskId,
        db
          .select({ id: schema.a2aTasksTable.id })
          .from(schema.a2aTasksTable)
          .where(
            and(
              inArray(schema.a2aTasksTable.state, [
                "TASK_STATE_COMPLETED",
                "TASK_STATE_FAILED",
                "TASK_STATE_CANCELED",
                "TASK_STATE_REJECTED",
              ]),
              lt(schema.a2aTasksTable.stateChangedAt, cutoff),
            ),
          ),
      ),
    );
  }

  static async updateState(
    id: string,
    state: A2ATaskState,
  ): Promise<A2ATask | null> {
    const [task] = await db
      .update(schema.a2aTasksTable)
      .set({ state, stateChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.a2aTasksTable.id, id))
      .returning();

    return task ?? null;
  }

  static async findById(id: string): Promise<A2ATask | null> {
    const [task] = await db
      .select()
      .from(schema.a2aTasksTable)
      .where(eq(schema.a2aTasksTable.id, id))
      .limit(1);

    return task ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aTasksTable)
      .where(eq(schema.a2aTasksTable.id, id));
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aTasksTable.id})` })
      .from(schema.a2aTasksTable);

    return Number(count);
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private static async touchContext(contextId: string): Promise<void> {
    await db
      .update(schema.a2aContextsTable)
      .set({ updatedAt: new Date() })
      .where(eq(schema.a2aContextsTable.id, contextId));
  }

  private static async transitionInTx(
    tx: DbTransaction,
    params: {
      id: string;
      to: A2ATaskState;
      allowedFrom: A2ATaskState[];
      statusReason?: string;
    },
  ): Promise<A2ATask | null> {
    const now = new Date();
    const [task] = await tx
      .update(schema.a2aTasksTable)
      .set({
        state: params.to,
        stateChangedAt: now,
        updatedAt: now,
        ...(params.statusReason !== undefined
          ? { statusReason: params.statusReason }
          : {}),
      })
      .where(
        and(
          eq(schema.a2aTasksTable.id, params.id),
          inArray(schema.a2aTasksTable.state, params.allowedFrom),
        ),
      )
      .returning();

    return task ?? null;
  }

  /** Allocate the next seq and insert the event — same-transaction only. */
  private static async appendEventInTx(
    tx: DbTransaction,
    taskId: string,
    payload: A2AProtocolStreamResponse,
  ): Promise<number> {
    const [allocated] = await tx
      .update(schema.a2aTasksTable)
      .set({ nextEventSeq: sql`${schema.a2aTasksTable.nextEventSeq} + 1` })
      .where(eq(schema.a2aTasksTable.id, taskId))
      .returning({ next: schema.a2aTasksTable.nextEventSeq });

    if (!allocated) {
      throw new Error(`A2A task ${taskId} vanished during event append`);
    }
    const seq = allocated.next - 1;

    await tx.insert(schema.a2aTaskEventsTable).values({
      taskId,
      seq,
      payload,
    });

    return seq;
  }

  private static async appendArtifactTextInTx(
    tx: DbTransaction,
    params: {
      taskId: string;
      id: string;
      name: string;
      appendText: string;
    },
  ): Promise<void> {
    const [existing] = await tx
      .select({ parts: schema.a2aArtifactsTable.parts })
      .from(schema.a2aArtifactsTable)
      .where(eq(schema.a2aArtifactsTable.id, params.id))
      .limit(1);

    if (!existing) {
      await tx.insert(schema.a2aArtifactsTable).values({
        id: params.id,
        taskId: params.taskId,
        name: params.name,
        parts: [{ text: params.appendText }],
      });
      return;
    }

    const [first, ...rest] = existing.parts;
    const updatedParts: A2AProtocolPart[] = [
      { ...first, text: `${first?.text ?? ""}${params.appendText}` },
      ...rest,
    ];
    await tx
      .update(schema.a2aArtifactsTable)
      .set({ parts: updatedParts, updatedAt: new Date() })
      .where(eq(schema.a2aArtifactsTable.id, params.id));
  }
}

export default A2ATaskModel;
