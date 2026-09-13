import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { AppaProxySessionProtocolError } from "./appa-proxy-session";

/**
 * Binds a stock Codex parent result to one issued child alias. The runtime
 * spawn binding remains the authority for creating the child session.
 */
export default class AppaNativeChildCorrelationModel {
  static async listIssuedSpawnSourceCallIds(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
  }): Promise<Set<string>> {
    assertIdentifiers(params);
    const [parent] = await db
      .select({ id: schema.appaProxySessionsTable.id })
      .from(schema.appaProxySessionsTable)
      .where(
        and(
          eq(schema.appaProxySessionsTable.id, params.parentSessionId),
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
        ),
      )
      .limit(1);
    if (!parent) {
      throw new AppaProxySessionProtocolError(
        "native child parent session is outside the owned profile lane",
      );
    }
    const rows = await db
      .select({ sourceCallId: schema.appaProxyWireAliasesTable.sourceCallId })
      .from(schema.appaProxyWireAliasesTable)
      .innerJoin(
        schema.appaProxyWireFramesTable,
        and(
          eq(
            schema.appaProxyWireAliasesTable.frameId,
            schema.appaProxyWireFramesTable.id,
          ),
          eq(
            schema.appaProxyWireAliasesTable.sessionId,
            schema.appaProxyWireFramesTable.sessionId,
          ),
        ),
      )
      .innerJoin(
        schema.appaProxyCallsTable,
        and(
          eq(
            schema.appaProxyWireAliasesTable.sessionId,
            schema.appaProxyCallsTable.sessionId,
          ),
          eq(
            schema.appaProxyWireAliasesTable.sourceCallId,
            schema.appaProxyCallsTable.callId,
          ),
        ),
      )
      .where(
        issuedSpawnAliasWhere({ parentSessionId: parent.id, now: new Date() }),
      );
    return new Set(
      rows.flatMap((row) => (row.sourceCallId ? [row.sourceCallId] : [])),
    );
  }

  static async bindIssuedSpawnResult(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    sourceCallId: string;
    childClientSessionId: string;
  }): Promise<void> {
    assertIdentifiers(params);
    await withDbTransaction(async (tx) => {
      const parent = await getOwnedParent({ tx, ...params });
      const aliases = await tx
        .select({
          id: schema.appaProxyWireAliasesTable.id,
          childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
        })
        .from(schema.appaProxyWireAliasesTable)
        .innerJoin(
          schema.appaProxyWireFramesTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.frameId,
              schema.appaProxyWireFramesTable.id,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyWireFramesTable.sessionId,
            ),
          ),
        )
        .innerJoin(
          schema.appaProxyCallsTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyCallsTable.sessionId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              schema.appaProxyCallsTable.callId,
            ),
          ),
        )
        .where(
          and(
            issuedSpawnAliasWhere({
              parentSessionId: parent.id,
              now: new Date(),
            }),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              params.sourceCallId,
            ),
          ),
        )
        .for("update");
      if (aliases.length !== 1) {
        throw new AppaProxySessionProtocolError(
          "native spawn result has no unique issued task alias",
        );
      }
      const alias = aliases[0];
      const [existingChild] = await tx
        .select({ id: schema.appaProxySessionsTable.id })
        .from(schema.appaProxySessionsTable)
        .where(
          and(
            eq(
              schema.appaProxySessionsTable.clientSessionId,
              params.childClientSessionId,
            ),
            eq(
              schema.appaProxySessionsTable.ownerScopeHash,
              params.ownerScopeHash,
            ),
          ),
        )
        .for("update");
      if (existingChild) {
        const [ownedChild] = await tx
          .select({ id: schema.appaProxySessionsTable.id })
          .from(schema.appaProxySessionsTable)
          .where(
            and(
              eq(schema.appaProxySessionsTable.id, existingChild.id),
              eq(schema.appaProxySessionsTable.profileId, params.profileId),
              eq(schema.appaProxySessionsTable.parentSessionId, parent.id),
              eq(
                schema.appaProxySessionsTable.parentCallId,
                params.sourceCallId,
              ),
              eq(schema.appaProxySessionsTable.rootId, parent.rootId),
            ),
          )
          .for("update");
        if (!ownedChild) {
          throw new AppaProxySessionProtocolError(
            "native spawn result child thread is outside the parent root",
          );
        }
      }
      const boundAliases = await tx
        .select({
          sourceCallId: schema.appaProxyWireAliasesTable.sourceCallId,
          childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
        })
        .from(schema.appaProxyWireAliasesTable)
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.sessionId, parent.id),
            eq(schema.appaProxyWireAliasesTable.kind, "task"),
          ),
        )
        .for("update");
      const duplicate = boundAliases.some(
        (candidate) =>
          candidate.sourceCallId !== params.sourceCallId &&
          candidate.childThreadId === params.childClientSessionId,
      );
      if (duplicate) {
        throw new AppaProxySessionProtocolError(
          "native spawn result child thread is already bound to a different call",
        );
      }
      if (
        alias.childThreadId &&
        alias.childThreadId !== params.childClientSessionId
      ) {
        throw new AppaProxySessionProtocolError(
          "native spawn result conflicts with an attached child thread",
        );
      }
      if (!alias.childThreadId) {
        const updated = await tx
          .update(schema.appaProxyWireAliasesTable)
          .set({ childThreadId: params.childClientSessionId })
          .where(
            and(
              eq(schema.appaProxyWireAliasesTable.id, alias.id),
              isNull(schema.appaProxyWireAliasesTable.childThreadId),
            ),
          )
          .returning({ id: schema.appaProxyWireAliasesTable.id });
        if (updated.length !== 1)
          throw new AppaProxySessionProtocolError(
            "native spawn result binding changed concurrently",
          );
      }
    });
  }
  static async findOwnedParentByClient(params: {
    ownerScopeHash: string;
    profileId: string;
    parentClientSessionId: string;
  }) {
    assertIdentifiers(params);
    const [parent] = await db
      .select({ id: schema.appaProxySessionsTable.id })
      .from(schema.appaProxySessionsTable)
      .where(
        and(
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
          eq(
            schema.appaProxySessionsTable.clientSessionId,
            params.parentClientSessionId,
          ),
        ),
      )
      .limit(1);
    if (!parent) {
      throw new AppaProxySessionProtocolError(
        "native child parent session is outside the owned profile lane",
      );
    }
    return parent;
  }

  static async findAttachedChild(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    childClientSessionId: string;
    sourceCallId: string;
  }): Promise<{ id: string } | null> {
    assertIdentifiers(params);
    const [parent] = await db
      .select({
        id: schema.appaProxySessionsTable.id,
        rootId: schema.appaProxySessionsTable.rootId,
      })
      .from(schema.appaProxySessionsTable)
      .where(
        and(
          eq(schema.appaProxySessionsTable.id, params.parentSessionId),
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
        ),
      )
      .limit(1);
    if (!parent) {
      throw new AppaProxySessionProtocolError(
        "native child parent session is outside the owned profile lane",
      );
    }
    const [child] = await db
      .select({ id: schema.appaProxySessionsTable.id })
      .from(schema.appaProxySessionsTable)
      .where(
        and(
          eq(
            schema.appaProxySessionsTable.clientSessionId,
            params.childClientSessionId,
          ),
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
          eq(schema.appaProxySessionsTable.parentSessionId, parent.id),
          eq(schema.appaProxySessionsTable.parentCallId, params.sourceCallId),
          eq(schema.appaProxySessionsTable.rootId, parent.rootId),
        ),
      )
      .limit(1);
    return child ?? null;
  }

  static async resolvePendingSpawn(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    taskAliasId: string;
    sourceCallId: string;
    childClientSessionId: string;
  }): Promise<{ spawnBinding: string }> {
    assertIdentifiers(params);
    return await withDbTransaction(async (tx) => {
      const parent = await getOwnedParent({ tx, ...params });
      const [pending] = await tx
        .select({ spawnBinding: schema.appaProxyCallsTable.spawnBinding })
        .from(schema.appaProxyWireAliasesTable)
        .innerJoin(
          schema.appaProxyWireFramesTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.frameId,
              schema.appaProxyWireFramesTable.id,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyWireFramesTable.sessionId,
            ),
          ),
        )
        .innerJoin(
          schema.appaProxyCallsTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyCallsTable.sessionId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              schema.appaProxyCallsTable.callId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.id, params.taskAliasId),
            eq(schema.appaProxyWireAliasesTable.sessionId, parent.id),
            eq(schema.appaProxyWireAliasesTable.kind, "task"),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              params.sourceCallId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.childThreadId,
              params.childClientSessionId,
            ),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
            inArray(schema.appaProxyWireFramesTable.state, [
              "issued",
              "completed",
            ]),
            eq(schema.appaProxyCallsTable.callId, params.sourceCallId),
            inArray(schema.appaProxyCallsTable.state, [
              "open",
              "result_admitted",
            ]),
            isNotNull(schema.appaProxyCallsTable.spawnBinding),
            inArray(
              schema.appaProxyCallsTable.emittedName,
              CODEX_SPAWN_TOOL_NAMES,
            ),
            isNull(schema.appaProxyCallsTable.spawnBindingConsumedAt),
          ),
        )
        .for("update");
      if (!pending?.spawnBinding) {
        throw new AppaProxySessionProtocolError(
          "native child task has no unconsumed runtime spawn binding",
        );
      }
      return { spawnBinding: pending.spawnBinding };
    });
  }

  static async attach(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    childClientSessionId: string;
    taskAliasId: string;
    sourceCallId: string;
    spawnBinding: string;
  }): Promise<void> {
    assertIdentifiers(params);
    await withDbTransaction(async (tx) => {
      const parent = await getOwnedParent({ tx, ...params });
      const child = await getAttachedChild({ tx, parent, ...params });
      if (!child.childStartedAt) {
        throw new AppaProxySessionProtocolError(
          "native child session has not started its acquired turn",
        );
      }
      const [alias] = await tx
        .select({ id: schema.appaProxyWireAliasesTable.id })
        .from(schema.appaProxyWireAliasesTable)
        .innerJoin(
          schema.appaProxyWireFramesTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.frameId,
              schema.appaProxyWireFramesTable.id,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyWireFramesTable.sessionId,
            ),
          ),
        )
        .innerJoin(
          schema.appaProxyCallsTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyCallsTable.sessionId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              schema.appaProxyCallsTable.callId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.id, params.taskAliasId),
            eq(schema.appaProxyWireAliasesTable.sessionId, parent.id),
            eq(schema.appaProxyWireAliasesTable.kind, "task"),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              params.sourceCallId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.childThreadId,
              child.clientSessionId,
            ),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
            inArray(schema.appaProxyWireFramesTable.state, [
              "issued",
              "completed",
            ]),
            eq(schema.appaProxyCallsTable.callId, params.sourceCallId),
            eq(schema.appaProxyCallsTable.spawnBinding, params.spawnBinding),
            isNotNull(schema.appaProxyCallsTable.spawnBindingConsumedAt),
          ),
        )
        .for("update");
      if (!alias) {
        throw new AppaProxySessionProtocolError(
          "native child task alias has no consumed runtime spawn binding",
        );
      }
    });
  }

  static async admitCompletion(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    childClientSessionId: string;
    taskAliasId: string;
    sourceCallId: string;
  }): Promise<void> {
    assertIdentifiers(params);
    await withDbTransaction(async (tx) => {
      const parent = await getOwnedParent({ tx, ...params });
      const child = await getAttachedChild({ tx, parent, ...params });
      const [alias] = await tx
        .select({ id: schema.appaProxyWireAliasesTable.id })
        .from(schema.appaProxyWireAliasesTable)
        .innerJoin(
          schema.appaProxyWireFramesTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.frameId,
              schema.appaProxyWireFramesTable.id,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyWireFramesTable.sessionId,
            ),
          ),
        )
        .innerJoin(
          schema.appaProxyCallsTable,
          and(
            eq(
              schema.appaProxyWireAliasesTable.sessionId,
              schema.appaProxyCallsTable.sessionId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              schema.appaProxyCallsTable.callId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.id, params.taskAliasId),
            eq(schema.appaProxyWireAliasesTable.sessionId, parent.id),
            eq(schema.appaProxyWireAliasesTable.kind, "task"),
            eq(
              schema.appaProxyWireAliasesTable.sourceCallId,
              params.sourceCallId,
            ),
            eq(
              schema.appaProxyWireAliasesTable.childThreadId,
              child.clientSessionId,
            ),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
            inArray(schema.appaProxyWireFramesTable.state, [
              "issued",
              "completed",
            ]),
            eq(schema.appaProxyCallsTable.callId, params.sourceCallId),
            isNotNull(schema.appaProxyCallsTable.spawnBindingConsumedAt),
          ),
        )
        .for("update");
      if (!alias) {
        throw new AppaProxySessionProtocolError(
          "native child completion has no attached task alias",
        );
      }
      const updated = await tx
        .update(schema.appaProxyWireAliasesTable)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.id, alias.id),
            eq(
              schema.appaProxyWireAliasesTable.childThreadId,
              child.clientSessionId,
            ),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
          ),
        )
        .returning({ id: schema.appaProxyWireAliasesTable.id });
      if (updated.length !== 1) {
        throw new AppaProxySessionProtocolError(
          "native child completion was already admitted",
        );
      }
    });
  }
}

async function getOwnedParent(params: {
  tx: Transaction;
  parentSessionId: string;
  ownerScopeHash: string;
  profileId: string;
}) {
  const [parent] = await params.tx
    .select()
    .from(schema.appaProxySessionsTable)
    .where(
      and(
        eq(schema.appaProxySessionsTable.id, params.parentSessionId),
        eq(schema.appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        eq(schema.appaProxySessionsTable.profileId, params.profileId),
      ),
    )
    .for("update");
  if (!parent) {
    throw new AppaProxySessionProtocolError(
      "native child parent session is outside the owned profile lane",
    );
  }
  return parent;
}

async function getAttachedChild(params: {
  tx: Transaction;
  parent: typeof schema.appaProxySessionsTable.$inferSelect;
  ownerScopeHash: string;
  profileId: string;
  childClientSessionId: string;
}) {
  const [child] = await params.tx
    .select()
    .from(schema.appaProxySessionsTable)
    .where(
      and(
        eq(
          schema.appaProxySessionsTable.clientSessionId,
          params.childClientSessionId,
        ),
        eq(schema.appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        eq(schema.appaProxySessionsTable.profileId, params.profileId),
        eq(schema.appaProxySessionsTable.parentSessionId, params.parent.id),
        eq(schema.appaProxySessionsTable.rootId, params.parent.rootId),
      ),
    )
    .for("update");
  if (!child) {
    throw new AppaProxySessionProtocolError(
      "native child session was not attached by the runtime spawn capability",
    );
  }
  return child;
}

function assertIdentifiers(params: Record<string, unknown>): void {
  for (const value of Object.values(params)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      throw new AppaProxySessionProtocolError(
        "native child correlation identifier is invalid",
      );
    }
  }
}

function issuedSpawnAliasWhere(params: { parentSessionId: string; now: Date }) {
  return and(
    eq(schema.appaProxyWireAliasesTable.sessionId, params.parentSessionId),
    eq(schema.appaProxyWireAliasesTable.kind, "task"),
    eq(schema.appaProxyWireFramesTable.state, "issued"),
    eq(schema.appaProxyWireFramesTable.kind, "model_response"),
    eq(schema.appaProxyWireFramesTable.protocol, "codex-native-response/v1"),
    gt(schema.appaProxyWireFramesTable.expiresAt, params.now),
    inArray(schema.appaProxyCallsTable.state, ["open", "result_admitted"]),
    isNotNull(schema.appaProxyCallsTable.spawnBinding),
    inArray(schema.appaProxyCallsTable.emittedName, CODEX_SPAWN_TOOL_NAMES),
  );
}

const CODEX_SPAWN_TOOL_NAMES = [
  "multi_agent_v1.spawn_agent",
  "agents.spawn_agent",
  "collaboration.spawn_agent",
] as const;
