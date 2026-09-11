import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { AppaProxySessionProtocolError } from "./appa-proxy-session";

/**
 * Persists only the relationship between an already runtime-attached child and
 * an issued task alias. The runtime spawn binding remains the authority for
 * creating the child session; a task alias is correlation data, not authority.
 */
export default class AppaNativeChildCorrelationModel {
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

  static async resolvePendingSpawn(params: {
    parentSessionId: string;
    ownerScopeHash: string;
    profileId: string;
    taskAliasId: string;
    sourceCallId: string;
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
            isNull(schema.appaProxyWireAliasesTable.childThreadId),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
            eq(schema.appaProxyWireFramesTable.state, "issued"),
            eq(schema.appaProxyCallsTable.callId, params.sourceCallId),
            eq(schema.appaProxyCallsTable.state, "open"),
            isNotNull(schema.appaProxyCallsTable.spawnBinding),
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
            isNull(schema.appaProxyWireAliasesTable.childThreadId),
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
      const updated = await tx
        .update(schema.appaProxyWireAliasesTable)
        .set({ childThreadId: child.clientSessionId })
        .where(
          and(
            eq(schema.appaProxyWireAliasesTable.id, alias.id),
            isNull(schema.appaProxyWireAliasesTable.childThreadId),
            isNull(schema.appaProxyWireAliasesTable.consumedAt),
          ),
        )
        .returning({ id: schema.appaProxyWireAliasesTable.id });
      if (updated.length !== 1) {
        throw new AppaProxySessionProtocolError(
          "native child task alias was already attached",
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
