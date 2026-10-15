import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  type RuntimeLaunchOutcome,
  RuntimeLaunchOutcomeSchema,
} from "@/types/openappa-runtime-launch";

const operations = schema.openappaOperationsTable;
const sessions = schema.openappaSessionsTable;
const unenforcedCalls = schema.openappaUnenforcedCallsTable;
const RUNTIME_LAUNCH_PREFIX = "runtime-launch:";

export type AllowedSpawnAlias = {
  spawnCallId: string;
  name?: string;
  description?: string;
  launchText?: string;
};

class OpenAppaSpawnCorrelationModel {
  /** Durable single execution claim; the native released-call row is immutable. */
  static async claimRuntimeDispatch(params: {
    organizationId: string;
    callerId: string | undefined;
    sessionId: string;
    toolCallId: string;
    spawn: boolean;
  }): Promise<boolean> {
    const result = await db.execute<{ operation_id: string }>(sql`
      INSERT INTO ${operations} (organization_id, session_id, caller_id, root, operation_id, status, input, decision)
      SELECT released.organization_id, released.session_id, released.caller_id, released.root,
        ${`runtime-dispatch:${params.toolCallId}`}, 'complete',
        ${JSON.stringify({ event: "runtime_dispatch", tool_call_id: params.toolCallId })}::jsonb,
        '{"decision":"ack"}'::jsonb
      FROM ${operations} AS released
      WHERE released.organization_id = ${params.organizationId}
        AND released.session_id = ${params.sessionId}
        AND released.caller_id IS NOT DISTINCT FROM ${params.callerId ?? null}
        AND released.operation_id = ${`call:${params.toolCallId}`}
        AND released.status = 'complete'
        AND released.decision->>'decision' = 'allow_call'
        AND COALESCE(released.input->'semantic'->>'spawn', released.input->>'spawn', 'false') = ${String(params.spawn)}
      ON CONFLICT DO NOTHING
      RETURNING operation_id
    `);
    return result.rows.length === 1;
  }

  /**
   * Durable single execution claim for a runtime call the proxy signed while
   * enforcement was off. Nothing released it, so the record that the session
   * made the call stands in for the released-call row, checked in the same
   * statement that claims it.
   */
  static async claimObservedRuntimeDispatch(params: {
    organizationId: string;
    callerId: string | undefined;
    sessionId: string;
    toolCallId: string;
  }): Promise<boolean> {
    const result = await db.execute<{ operation_id: string }>(sql`
      INSERT INTO ${operations} (organization_id, session_id, caller_id, root, operation_id, status, input, decision)
      SELECT source.organization_id, source.session_id, source.caller_id, source.root,
        ${`runtime-dispatch:${params.toolCallId}`}, 'complete',
        ${JSON.stringify({ event: "runtime_dispatch", tool_call_id: params.toolCallId, observed: true })}::jsonb,
        '{"decision":"ack"}'::jsonb
      FROM ${sessions} AS source
      JOIN ${unenforcedCalls} AS made
        ON made.organization_id = source.organization_id
        AND made.session_id = source.session_id
      WHERE source.organization_id = ${params.organizationId}
        AND source.session_id = ${params.sessionId}
        AND source.caller_id IS NOT DISTINCT FROM ${params.callerId ?? null}
        AND made.tool_call_id = ${params.toolCallId}
        AND made.reason = 'made'
      ON CONFLICT DO NOTHING
      RETURNING operation_id
    `);
    return result.rows.length === 1;
  }

  static async releasedCalls(params: {
    organizationId: string;
    callerId: string | undefined;
    sessionId: string;
    toolCallIds: string[];
  }): Promise<Map<string, { spawn: boolean; tool: string }>> {
    if (params.toolCallIds.length === 0) return new Map();
    const rows = await db
      .select({
        operationId: operations.operationId,
        tool: sql<string>`COALESCE(${operations.input}->'semantic'->>'tool', ${operations.input}->'context'->>'tool', ${operations.input}->>'tool', '')`,
        spawn: sql<string>`COALESCE(${operations.input}->'semantic'->>'spawn', ${operations.input}->>'spawn', 'false')`,
      })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          inArray(
            operations.operationId,
            params.toolCallIds.map((id) => `call:${id}`),
          ),
          eq(operations.status, "complete"),
          sql`${operations.decision}->>'decision' = 'allow_call'`,
        ),
      );
    return new Map(
      rows.map((row) => [
        row.operationId.slice(5),
        {
          spawn: row.spawn === "true",
          tool: row.tool,
        },
      ]),
    );
  }

  /**
   * Records, once, what the gateway did with a released runtime launch, under
   * the call's own id. The proxy reports this record to the model, not the
   * result the client sends back.
   */
  static async recordRuntimeLaunch(params: {
    organizationId: string;
    callerId: string | undefined;
    sessionId: string;
    toolCallId: string;
    outcome: RuntimeLaunchOutcome;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO ${operations} (organization_id, session_id, caller_id, root, operation_id, status, input, decision)
      SELECT released.organization_id, released.session_id, released.caller_id, released.root,
        ${`${RUNTIME_LAUNCH_PREFIX}${params.toolCallId}`}, 'complete',
        ${JSON.stringify({ event: "runtime_launch", tool_call_id: params.toolCallId, outcome: params.outcome })}::jsonb,
        '{"decision":"ack"}'::jsonb
      FROM ${operations} AS released
      WHERE released.organization_id = ${params.organizationId}
        AND released.session_id = ${params.sessionId}
        AND released.caller_id IS NOT DISTINCT FROM ${params.callerId ?? null}
        AND released.operation_id = ${`call:${params.toolCallId}`}
        AND released.status = 'complete'
        AND released.decision->>'decision' = 'allow_call'
      ON CONFLICT DO NOTHING
    `);
  }

  /** The recorded outcome of each released runtime launch that has one. */
  static async runtimeLaunches(params: {
    organizationId: string;
    callerId: string | undefined;
    sessionId: string;
    toolCallIds: string[];
  }): Promise<Map<string, RuntimeLaunchOutcome>> {
    if (params.toolCallIds.length === 0) return new Map();
    const rows = await db
      .select({
        operationId: operations.operationId,
        outcome: sql<unknown>`${operations.input}->'outcome'`,
      })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          inArray(
            operations.operationId,
            params.toolCallIds.map((id) => `${RUNTIME_LAUNCH_PREFIX}${id}`),
          ),
          eq(operations.status, "complete"),
        ),
      );
    const launches = new Map<string, RuntimeLaunchOutcome>();
    for (const row of rows) {
      const outcome = RuntimeLaunchOutcomeSchema.safeParse(row.outcome);
      if (outcome.success) {
        launches.set(
          row.operationId.slice(RUNTIME_LAUNCH_PREFIX.length),
          outcome.data,
        );
      }
    }
    return launches;
  }

  /**
   * Recovers only the signed spawn binding stored with a child's own event.
   * A parent's sole open call could belong to a different async child.
   */
  static async soleOpenSpawn(params: {
    organizationId: string;
    callerId: string | undefined;
    parentSessionId: string;
    childSessionId: string;
  }): Promise<string | null> {
    const callerScope = params.callerId
      ? eq(sessions.callerId, params.callerId)
      : isNull(sessions.callerId);
    const [binding] = await db
      .select({ actor: sessions.actor })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, params.organizationId),
          eq(sessions.sessionId, params.childSessionId),
          eq(sessions.parentId, params.parentSessionId),
          callerScope,
        ),
      )
      .limit(1);
    if (!binding) return null;
    const storedCallId = sql<string>`COALESCE(${operations.input}->'semantic'->>'spawn_call_id', ${operations.input}->>'spawn_call_id')`;
    const rows = await db
      .selectDistinct({ toolCallId: storedCallId })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.childSessionId),
          eq(operations.status, "complete"),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          sql`COALESCE(${operations.input}->'semantic'->>'event', ${operations.input}->>'event') IN ('prompt', 'tool_call')`,
          sql`${storedCallId} IS NOT NULL`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) return null;

    const allowed = await OpenAppaSpawnCorrelationModel.allowedSpawn({
      organizationId: params.organizationId,
      callerId: params.callerId,
      parentSessionId: params.parentSessionId,
      spawnCallId: rows[0].toolCallId,
    });
    return allowed ? rows[0].toolCallId : null;
  }

  /**
   * Names a parent is on record for giving the agents it was allowed to
   * start. Request history can drop these after compaction; the spawn
   * operation's semantic arguments do not.
   */
  static async allowedSpawnAliases(params: {
    organizationId: string;
    callerId: string | undefined;
    parentSessionId: string;
  }): Promise<AllowedSpawnAlias[]> {
    const results = schema.openappaProcessedResultsTable;
    const rows = await db
      .select({
        operationId: operations.operationId,
        arguments: sql<unknown>`COALESCE(${operations.input}->'semantic'->'arguments', ${operations.input}->'context'->'arguments', ${operations.input}->'arguments')`,
        launchText: results.approvedOutput,
      })
      .from(operations)
      .leftJoin(
        results,
        and(
          eq(results.organizationId, operations.organizationId),
          eq(results.sessionId, operations.sessionId),
          eq(results.status, "complete"),
          eq(
            results.toolCallId,
            sql`substring(${operations.operationId} from 6)`,
          ),
          params.callerId
            ? eq(results.callerId, params.callerId)
            : isNull(results.callerId),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.parentSessionId),
          eq(operations.status, "complete"),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          sql`COALESCE(${operations.input}->'semantic'->>'spawn', ${operations.input}->>'spawn') = 'true'`,
          sql`${operations.decision}->>'decision' = 'allow_call'`,
          sql`${operations.operationId} LIKE 'call:%'`,
        ),
      );
    return rows.flatMap((row) => {
      const alias = aliasFromArguments(row.arguments);
      if (!alias.name && !alias.description && !row.launchText) return [];
      return [
        {
          spawnCallId: row.operationId.slice("call:".length),
          ...(alias.name ? { name: alias.name } : {}),
          ...(alias.description ? { description: alias.description } : {}),
          ...(row.launchText ? { launchText: row.launchText } : {}),
        },
      ];
    });
  }

  /** Whether the runtime allowed `spawnCallId` as a spawn in the parent session. */
  static async allowedSpawn(params: {
    organizationId: string;
    callerId: string | undefined;
    parentSessionId: string;
    spawnCallId: string;
  }): Promise<boolean> {
    const [spawn] = await db
      .select({ operationId: operations.operationId })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.parentSessionId),
          eq(operations.operationId, `call:${params.spawnCallId}`),
          eq(operations.status, "complete"),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          sql`COALESCE(${operations.input}->'semantic'->>'spawn', ${operations.input}->>'spawn') = 'true'`,
          sql`${operations.decision}->>'decision' = 'allow_call'`,
        ),
      )
      .limit(1);
    return spawn !== undefined;
  }
}

function aliasFromArguments(value: unknown): {
  name?: string;
  description?: string;
} {
  const record =
    typeof value === "string"
      ? parseJson(value)
      : isRecord(value)
        ? value
        : undefined;
  if (!record) return {};
  const name = stringField(record.name);
  const description = stringField(record.description);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export default OpenAppaSpawnCorrelationModel;
