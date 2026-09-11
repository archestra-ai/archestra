import { and, count, eq, inArray, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { AppaProxyCall, AppaProxySession } from "@/types";

class AppaProxySessionBusyError extends Error {
  constructor() {
    super("OpenAPPA session already has an active turn");
    this.name = "AppaProxySessionBusyError";
  }
}

class AppaProxySessionQuarantinedError extends Error {
  constructor() {
    super("OpenAPPA session is quarantined after an uncertain remote event");
    this.name = "AppaProxySessionQuarantinedError";
  }
}

export class AppaProxySessionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppaProxySessionProtocolError";
  }
}
class AppaProxySessionBudgetError extends AppaProxySessionProtocolError {}

type Turn = {
  session: AppaProxySession;
  turnId: string;
  created: boolean;
};

type SessionBinding = {
  provider: string;
  protocol: string;
  model: string;
};

type OutboundCall = {
  callId: string;
  emittedName: string;
  emittedArguments: string;
  emittedArgumentsCanonical: string;
  appaTargetName: string;
  appaTargetArguments: Record<string, unknown>;
};

class AppaProxySessionModel {
  static async enterTurn(params: {
    profileId: string;
    ownerScopeHash: string;
    clientSessionId: string;
    rootId: string;
    turnId: string;
    maxSessionsPerOwner: number;
    binding?: SessionBinding;
    parentClientSessionId?: string;
    spawnBinding?: string;
  }): Promise<Turn> {
    return await withDbTransaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${params.ownerScopeHash}, 0))`,
      );
      let [session] = await tx
        .select()
        .from(schema.appaProxySessionsTable)
        .where(
          and(
            eq(
              schema.appaProxySessionsTable.ownerScopeHash,
              params.ownerScopeHash,
            ),
            eq(
              schema.appaProxySessionsTable.clientSessionId,
              params.clientSessionId,
            ),
          ),
        )
        .limit(1);
      let created = false;
      if (session) {
        assertSessionBinding(session, params.binding ?? directBinding());
      }
      if (!session) {
        let parent:
          | typeof schema.appaProxySessionsTable.$inferSelect
          | undefined;
        let parentCall:
          | typeof schema.appaProxyCallsTable.$inferSelect
          | undefined;
        if (params.parentClientSessionId || params.spawnBinding) {
          if (!params.parentClientSessionId || !params.spawnBinding) {
            throw new AppaProxySessionProtocolError(
              "child thread requires a server-issued spawn capability",
            );
          }
          [parent] = await tx
            .select()
            .from(schema.appaProxySessionsTable)
            .where(
              and(
                eq(
                  schema.appaProxySessionsTable.ownerScopeHash,
                  params.ownerScopeHash,
                ),
                eq(
                  schema.appaProxySessionsTable.clientSessionId,
                  params.parentClientSessionId,
                ),
              ),
            )
            .limit(1);
          if (!parent || parent.profileId !== params.profileId) {
            throw new AppaProxySessionProtocolError(
              "child thread has no authorized parent session",
            );
          }
          assertSessionBinding(parent, params.binding ?? directBinding());
          const parentCalls = await tx
            .select()
            .from(schema.appaProxyCallsTable)
            .where(
              and(
                eq(schema.appaProxyCallsTable.sessionId, parent.id),
                inArray(schema.appaProxyCallsTable.state, [
                  "open",
                  "result_admitted",
                ]),
                eq(
                  schema.appaProxyCallsTable.spawnBinding,
                  params.spawnBinding,
                ),
                sql`${schema.appaProxyCallsTable.spawnBindingConsumedAt} is null`,
              ),
            )
            .for("update");
          if (parentCalls.length !== 1) {
            throw new AppaProxySessionProtocolError(
              "child thread has no unconsumed authorized spawn capability",
            );
          }
          parentCall = parentCalls[0];
          const consumed = await tx
            .update(schema.appaProxyCallsTable)
            .set({ spawnBindingConsumedAt: new Date() })
            .where(
              and(
                eq(schema.appaProxyCallsTable.id, parentCall.id),
                eq(
                  schema.appaProxyCallsTable.spawnBinding,
                  params.spawnBinding,
                ),
                sql`${schema.appaProxyCallsTable.spawnBindingConsumedAt} is null`,
              ),
            )
            .returning({ id: schema.appaProxyCallsTable.id });
          if (consumed.length !== 1) {
            throw new AppaProxySessionProtocolError(
              "spawn capability was already consumed",
            );
          }
        }
        const [{ sessions }] = await tx
          .select({ sessions: count() })
          .from(schema.appaProxySessionsTable)
          .where(
            eq(
              schema.appaProxySessionsTable.ownerScopeHash,
              params.ownerScopeHash,
            ),
          );
        if (sessions >= params.maxSessionsPerOwner) {
          throw new AppaProxySessionBudgetError(
            "OpenAPPA owner session limit exceeded",
          );
        }
        [session] = await tx
          .insert(schema.appaProxySessionsTable)
          .values({
            profileId: params.profileId,
            ownerScopeHash: params.ownerScopeHash,
            clientSessionId: params.clientSessionId,
            provider: (params.binding ?? directBinding()).provider,
            protocol: (params.binding ?? directBinding()).protocol,
            model: (params.binding ?? directBinding()).model,
            rootId: parent?.rootId ?? params.rootId,
            rootInitializedAt: parent?.rootInitializedAt ?? null,
            parentSessionId: parent?.id ?? null,
            parentCallId: parentCall?.callId ?? null,
          })
          .returning();
        created = true;
      }
      if (!session) throw new Error("failed to create OpenAPPA session");
      const claimed = await tx
        .update(schema.appaProxySessionsTable)
        .set({
          state: "in_turn",
          activeTurnId: params.turnId,
          pendingRemoteEvent: null,
        })
        .where(
          and(
            eq(schema.appaProxySessionsTable.id, session.id),
            eq(schema.appaProxySessionsTable.state, "ready"),
          ),
        )
        .returning();
      if (claimed[0]) {
        return { session: claimed[0], turnId: params.turnId, created };
      }
      if (session.state === "quarantined") {
        throw new AppaProxySessionQuarantinedError();
      }
      throw new AppaProxySessionBusyError();
    });
  }

  static async hasOwnedSession(params: {
    profileId: string;
    ownerScopeHash: string;
    clientSessionId: string;
    binding?: SessionBinding;
  }): Promise<boolean> {
    const [session] = await db
      .select()
      .from(schema.appaProxySessionsTable)
      .where(
        and(
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(
            schema.appaProxySessionsTable.clientSessionId,
            params.clientSessionId,
          ),
        ),
      )
      .limit(1);
    if (session)
      assertSessionBinding(session, params.binding ?? directBinding());
    return session !== undefined;
  }

  /**
   * Claims the already occupied turn for a held-response continuation. Unlike
   * `enterTurn`, this cannot advance the session or accept a new model prompt.
   */
  static async claimHeldTurn(params: {
    sessionId: string;
    ownerScopeHash: string;
    turnId: string;
  }): Promise<Turn> {
    return await withDbTransaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(schema.appaProxySessionsTable)
        .where(
          and(
            eq(schema.appaProxySessionsTable.id, params.sessionId),
            eq(
              schema.appaProxySessionsTable.ownerScopeHash,
              params.ownerScopeHash,
            ),
            eq(schema.appaProxySessionsTable.state, "in_turn"),
            eq(schema.appaProxySessionsTable.activeTurnId, params.turnId),
            sql`${schema.appaProxySessionsTable.pendingRemoteEvent} is null`,
          ),
        )
        .for("update");
      if (!session) {
        throw new AppaProxySessionProtocolError(
          "held APPA turn is not available for continuation",
        );
      }
      return { session, turnId: params.turnId, created: false };
    });
  }

  static async listCalls(sessionId: string): Promise<AppaProxyCall[]> {
    return await db
      .select()
      .from(schema.appaProxyCallsTable)
      .where(eq(schema.appaProxyCallsTable.sessionId, sessionId));
  }

  static async markRemoteIntent(turn: Turn, event: string): Promise<void> {
    await assertTurnUpdate(turn, { pendingRemoteEvent: event });
  }

  static async markRemoteSettled(turn: Turn): Promise<void> {
    await assertTurnUpdate(turn, { pendingRemoteEvent: null });
  }

  static async createRemoteEventIntent(params: {
    turn: Turn;
    eventId: string;
    event: string;
    requestBody: string;
    requestSha256: string;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx.insert(schema.appaProxyEventsTable).values({
        sessionId: params.turn.session.id,
        eventId: params.eventId,
        event: params.event,
        requestBody: params.requestBody,
        requestSha256: params.requestSha256,
      });
      const rows = await tx
        .update(schema.appaProxySessionsTable)
        .set({ pendingRemoteEvent: params.eventId })
        .where(turnWhere(params.turn))
        .returning({ id: schema.appaProxySessionsTable.id });
      if (rows.length !== 1)
        throw new AppaProxySessionProtocolError("turn ownership lost");
    });
  }

  static async settleRemoteEvent(
    turn: Turn,
    eventId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      const events = await tx
        .update(schema.appaProxyEventsTable)
        .set({ response, settledAt: new Date() })
        .where(
          and(
            eq(schema.appaProxyEventsTable.sessionId, turn.session.id),
            eq(schema.appaProxyEventsTable.eventId, eventId),
            sql`${schema.appaProxyEventsTable.settledAt} is null`,
          ),
        )
        .returning({ id: schema.appaProxyEventsTable.id });
      if (events.length !== 1)
        throw new AppaProxySessionProtocolError(
          "remote event receipt changed unexpectedly",
        );
      const rows = await tx
        .update(schema.appaProxySessionsTable)
        .set({ pendingRemoteEvent: null })
        .where(turnWhere(turn))
        .returning({ id: schema.appaProxySessionsTable.id });
      if (rows.length !== 1)
        throw new AppaProxySessionProtocolError("turn ownership lost");
    });
  }

  static async markRootInitialized(turn: Turn): Promise<void> {
    const rows = await db
      .update(schema.appaProxySessionsTable)
      .set({ rootInitializedAt: new Date(), pendingRemoteEvent: null })
      .where(turnWhere(turn))
      .returning({ id: schema.appaProxySessionsTable.id });
    if (rows.length !== 1)
      throw new AppaProxySessionProtocolError("turn ownership lost");
  }

  static async getChildSpawnBinding(turn: Turn): Promise<string | null> {
    const { parentSessionId, parentCallId } = turn.session;
    if (!parentSessionId || !parentCallId) return null;
    const [call] = await db
      .select({ spawnBinding: schema.appaProxyCallsTable.spawnBinding })
      .from(schema.appaProxyCallsTable)
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, parentSessionId),
          eq(schema.appaProxyCallsTable.callId, parentCallId),
          sql`${schema.appaProxyCallsTable.spawnBinding} is not null`,
        ),
      )
      .limit(1);
    return call?.spawnBinding ?? null;
  }

  static async markChildStarted(turn: Turn): Promise<void> {
    const rows = await db
      .update(schema.appaProxySessionsTable)
      .set({ childStartedAt: new Date() })
      .where(turnWhere(turn))
      .returning({ id: schema.appaProxySessionsTable.id });
    if (rows.length !== 1)
      throw new AppaProxySessionProtocolError("turn ownership lost");
  }

  static async beginResultAdmission(params: {
    turn: Turn;
    results: Array<{
      callId: string;
      resultHash: string;
      resultStatus: "success" | "failure" | "indeterminate";
      resultMessageHash: string | null;
      resultPresentation: string | null;
    }>;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      const calls = await tx
        .select()
        .from(schema.appaProxyCallsTable)
        .where(
          and(
            eq(schema.appaProxyCallsTable.sessionId, params.turn.session.id),
            inArray(
              schema.appaProxyCallsTable.callId,
              params.results.map((result) => result.callId),
            ),
          ),
        )
        .for("update");
      if (
        calls.length !== params.results.length ||
        calls.some((call) => call.state !== "open")
      ) {
        throw new AppaProxySessionProtocolError("tool result is not pending");
      }
      for (const result of params.results) {
        await tx
          .update(schema.appaProxyCallsTable)
          .set({
            state: "result_intent",
            resultHash: result.resultHash,
            resultStatus: result.resultStatus,
            resultMessageHash: result.resultMessageHash,
            resultPresentation: result.resultPresentation,
          })
          .where(
            and(
              eq(schema.appaProxyCallsTable.sessionId, params.turn.session.id),
              eq(schema.appaProxyCallsTable.callId, result.callId),
              eq(schema.appaProxyCallsTable.state, "open"),
            ),
          );
      }
    });
  }

  static async admitResults(turn: Turn, callIds: string[]): Promise<void> {
    if (callIds.length === 0) return;
    const rows = await db
      .update(schema.appaProxyCallsTable)
      .set({ state: "result_admitted" })
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, turn.session.id),
          eq(schema.appaProxyCallsTable.state, "result_intent"),
          inArray(schema.appaProxyCallsTable.callId, callIds),
        ),
      )
      .returning({ id: schema.appaProxyCallsTable.id });
    if (rows.length !== callIds.length) {
      throw new AppaProxySessionProtocolError(
        "tool result admission changed unexpectedly",
      );
    }
  }

  static async setResultPresentations(params: {
    turn: Turn;
    presentations: Array<{ callId: string; presentation: string }>;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      for (const { callId, presentation } of params.presentations) {
        const rows = await tx
          .update(schema.appaProxyCallsTable)
          .set({ resultPresentation: presentation })
          .where(
            and(
              eq(schema.appaProxyCallsTable.sessionId, params.turn.session.id),
              eq(schema.appaProxyCallsTable.callId, callId),
              eq(schema.appaProxyCallsTable.state, "result_intent"),
            ),
          )
          .returning({ id: schema.appaProxyCallsTable.id });
        if (rows.length !== 1) {
          throw new AppaProxySessionProtocolError(
            "tool result presentation changed unexpectedly",
          );
        }
      }
    });
  }

  static async revertResultIntent(
    turn: Turn,
    callIds: string[],
  ): Promise<void> {
    if (callIds.length === 0) return;
    await db
      .update(schema.appaProxyCallsTable)
      .set({
        state: "open",
        resultHash: null,
        resultStatus: null,
        resultMessageHash: null,
        resultPresentation: null,
      })
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, turn.session.id),
          eq(schema.appaProxyCallsTable.state, "result_intent"),
          inArray(schema.appaProxyCallsTable.callId, callIds),
        ),
      );
  }

  static async createOutboundIntent(params: {
    turn: Turn;
    calls: OutboundCall[];
    maxCallsPerSession: number;
  }): Promise<void> {
    const { turn, calls, maxCallsPerSession } = params;
    if (calls.length === 0) return;
    if (new Set(calls.map((call) => call.callId)).size !== calls.length) {
      throw new AppaProxySessionProtocolError(
        "provider emitted duplicate tool call ids",
      );
    }
    const [{ calls: existingCalls }] = await db
      .select({ calls: count() })
      .from(schema.appaProxyCallsTable)
      .where(eq(schema.appaProxyCallsTable.sessionId, turn.session.id));
    if (existingCalls + calls.length > maxCallsPerSession) {
      throw new AppaProxySessionBudgetError(
        "OpenAPPA session call limit exceeded",
      );
    }
    await db.insert(schema.appaProxyCallsTable).values(
      calls.map((call) => ({
        sessionId: turn.session.id,
        ...call,
        state: "authorization_intent" as const,
      })),
    );
  }

  static async approveOutboundCalls(
    turn: Turn,
    callIds: string[],
  ): Promise<void> {
    if (callIds.length === 0) return;
    const rows = await db
      .update(schema.appaProxyCallsTable)
      .set({ state: "open" })
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, turn.session.id),
          eq(schema.appaProxyCallsTable.state, "authorization_intent"),
          inArray(schema.appaProxyCallsTable.callId, callIds),
        ),
      )
      .returning({ id: schema.appaProxyCallsTable.id });
    if (rows.length !== callIds.length) {
      throw new AppaProxySessionProtocolError(
        "tool authorization changed unexpectedly",
      );
    }
  }

  static async approveOutboundCallBatch(params: {
    turn: Turn;
    calls: Array<{
      callId: string;
      dispatchId: string;
      spawnBinding: string | null;
      effectiveCall?: OutboundCall;
    }>;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      for (const call of params.calls) {
        if (call.effectiveCall && call.effectiveCall.callId !== call.callId) {
          throw new AppaProxySessionProtocolError(
            "effective call identity changed",
          );
        }
        const rows = await tx
          .update(schema.appaProxyCallsTable)
          .set({
            state: "open",
            dispatchId: call.dispatchId,
            spawnBinding: call.spawnBinding,
            ...(call.effectiveCall
              ? {
                  emittedName: call.effectiveCall.emittedName,
                  emittedArguments: call.effectiveCall.emittedArguments,
                  emittedArgumentsCanonical:
                    call.effectiveCall.emittedArgumentsCanonical,
                  appaTargetName: call.effectiveCall.appaTargetName,
                  appaTargetArguments: call.effectiveCall.appaTargetArguments,
                }
              : {}),
          })
          .where(
            and(
              eq(schema.appaProxyCallsTable.sessionId, params.turn.session.id),
              eq(schema.appaProxyCallsTable.callId, call.callId),
              eq(schema.appaProxyCallsTable.state, "authorization_intent"),
            ),
          )
          .returning({ id: schema.appaProxyCallsTable.id });
        if (rows.length !== 1) {
          throw new AppaProxySessionProtocolError(
            "tool authorization changed unexpectedly",
          );
        }
      }
    });
  }

  static async denyOutboundCalls(turn: Turn, callIds: string[]): Promise<void> {
    if (callIds.length === 0) return;
    await db
      .update(schema.appaProxyCallsTable)
      .set({ state: "denied" })
      .where(
        and(
          eq(schema.appaProxyCallsTable.sessionId, turn.session.id),
          eq(schema.appaProxyCallsTable.state, "authorization_intent"),
          inArray(schema.appaProxyCallsTable.callId, callIds),
        ),
      );
  }

  static async releaseTurn(turn: Turn): Promise<void> {
    const rows = await db
      .update(schema.appaProxySessionsTable)
      .set({ state: "ready", activeTurnId: null, pendingRemoteEvent: null })
      .where(turnWhere(turn))
      .returning({ id: schema.appaProxySessionsTable.id });
    if (rows.length !== 1)
      throw new AppaProxySessionProtocolError("turn ownership lost");
  }

  static async quarantineTurn(turn: Turn): Promise<void> {
    await db
      .update(schema.appaProxySessionsTable)
      .set({ state: "quarantined" })
      .where(turnWhere(turn));
  }

  static async quarantineUndeliveredCalls(turn: Turn): Promise<void> {
    // A response can close after `finish` releases an open call but before the
    // call entered the outbound response. Only that durable combination may be
    // promoted from ready to manual quarantine.
    await db
      .update(schema.appaProxySessionsTable)
      .set({
        state: "quarantined",
        activeTurnId: null,
        pendingRemoteEvent: null,
      })
      .where(sql`
        ${schema.appaProxySessionsTable.id} = ${turn.session.id}
        and (
          (
            ${schema.appaProxySessionsTable.state} = 'in_turn'
            and ${schema.appaProxySessionsTable.activeTurnId} = ${turn.turnId}
          )
          or (
            ${schema.appaProxySessionsTable.state} = 'ready'
            and ${schema.appaProxySessionsTable.activeTurnId} is null
            and exists (
              select 1
              from ${schema.appaProxyCallsTable}
              where ${schema.appaProxyCallsTable.sessionId} = ${turn.session.id}
                and ${schema.appaProxyCallsTable.state} = 'open'
            )
          )
        )
      `);
  }
}

export default AppaProxySessionModel;

function assertSessionBinding(
  session: typeof schema.appaProxySessionsTable.$inferSelect,
  binding: SessionBinding,
): void {
  if (
    !session.provider ||
    !session.protocol ||
    !session.model ||
    session.provider !== binding.provider ||
    session.protocol !== binding.protocol ||
    session.model !== binding.model
  ) {
    throw new AppaProxySessionProtocolError(
      "APPA session binding does not match this provider trajectory",
    );
  }
}

function directBinding(): SessionBinding {
  return { provider: "direct", protocol: "direct", model: "direct" };
}

async function assertTurnUpdate(
  turn: Turn,
  values: { pendingRemoteEvent: string | null },
): Promise<void> {
  const rows = await db
    .update(schema.appaProxySessionsTable)
    .set(values)
    .where(turnWhere(turn))
    .returning({ id: schema.appaProxySessionsTable.id });
  if (rows.length !== 1)
    throw new AppaProxySessionProtocolError("turn ownership lost");
}

function turnWhere(turn: Turn) {
  return and(
    eq(schema.appaProxySessionsTable.id, turn.session.id),
    eq(schema.appaProxySessionsTable.state, "in_turn"),
    eq(schema.appaProxySessionsTable.activeTurnId, turn.turnId),
  );
}
