import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";

/** Fleet snapshots survive process restarts and include work owned by other replicas. */
class AgentRuntimeHealthModel {
  static async snapshot(now = new Date()) {
    const runs = schema.agentRunsTable;
    const tasks = schema.a2aTasksTable;
    const agents = schema.agentsTable;
    const backend = sql<string>`coalesce(${runs.backend}, ${agents.runtime}->>'backend', 'kubernetes')`;
    const active = sql`${tasks.state} IN ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING')`;
    const live = sql`${tasks.state} IN ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED')`;
    const terminal = sql`${tasks.state} IN ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED')`;
    const undelivered = sql`${terminal} AND ${runs.completionTarget} IS NOT NULL AND ${runs.completionNotifiedAt} IS NULL`;
    const recent = new Date(now.getTime() - 15 * 60_000);
    return db
      .select({
        agentId: agents.id,
        backend,
        working:
          sql<number>`count(*) FILTER (WHERE ${tasks.state} = 'TASK_STATE_WORKING')`.mapWith(
            Number,
          ),
        submitted:
          sql<number>`count(*) FILTER (WHERE ${tasks.state} = 'TASK_STATE_SUBMITTED')`.mapWith(
            Number,
          ),
        inputRequired:
          sql<number>`count(*) FILTER (WHERE ${live} AND (${runs.attentionState} = 'input_required' OR ${tasks.state} = 'TASK_STATE_INPUT_REQUIRED'))`.mapWith(
            Number,
          ),
        authRequired:
          sql<number>`count(*) FILTER (WHERE ${live} AND (${runs.attentionState} = 'auth_required' OR ${tasks.state} = 'TASK_STATE_AUTH_REQUIRED'))`.mapWith(
            Number,
          ),
        failedRecent:
          sql<number>`count(*) FILTER (WHERE ${tasks.state} = 'TASK_STATE_FAILED' AND ${tasks.stateChangedAt} >= ${recent})`.mapWith(
            Number,
          ),
        completionPending:
          sql<number>`count(*) FILTER (WHERE ${undelivered})`.mapWith(Number),
        heartbeatAge:
          sql<number>`coalesce(max(greatest(0, extract(epoch FROM (${now}::timestamp - coalesce(${tasks.lastHeartbeatAt}, ${tasks.createdAt}))))) FILTER (WHERE ${active}), 0)`.mapWith(
            Number,
          ),
        submittedAge:
          sql<number>`coalesce(max(greatest(0, extract(epoch FROM (${now}::timestamp - coalesce(${tasks.stateChangedAt}, ${tasks.createdAt}))))) FILTER (WHERE ${tasks.state} = 'TASK_STATE_SUBMITTED'), 0)`.mapWith(
            Number,
          ),
        completionAge:
          sql<number>`coalesce(max(greatest(0, extract(epoch FROM (${now}::timestamp - coalesce(${tasks.stateChangedAt}, ${runs.endedAt}, ${tasks.updatedAt}))))) FILTER (WHERE ${undelivered}), 0)`.mapWith(
            Number,
          ),
      })
      .from(tasks)
      .innerJoin(agents, eq(tasks.agentId, agents.id))
      .leftJoin(runs, eq(runs.taskId, tasks.id))
      .where(
        and(
          or(isNotNull(runs.id), isNotNull(agents.runtime)),
          or(
            live,
            sql`${tasks.stateChangedAt} >= ${recent}`,
            and(
              isNotNull(runs.completionTarget),
              isNull(runs.completionNotifiedAt),
              terminal,
            ),
          ),
        ),
      )
      .groupBy(agents.id, backend);
  }
}

export default AgentRuntimeHealthModel;
