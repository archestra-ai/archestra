import { and, asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  AppaOpaqueHistoryScope,
  AppaOpaqueHistoryTrigger,
  AppaOpaqueHistoryWindowRef,
} from "@/types";

type IssuedItem = {
  providerItemId: string | null;
  serverIdentity: string;
  itemType: string;
  identityHash: string;
  canonicalPayloadEncrypted: string;
  canonicalPayloadBytes: number;
};

type OpaqueWindow = typeof schema.appaOpaqueHistoryWindowsTable.$inferSelect;
type OpaqueItem = typeof schema.appaOpaqueHistoryItemsTable.$inferSelect;

class AppaOpaqueHistoryModel {
  static async getCompactionState(scope: AppaOpaqueHistoryScope): Promise<{
    sessionState: "ready" | "in_turn" | "quarantined";
    activeTurnId: string | null;
    outstandingCallCount: number;
    safePresentations: Array<{ callId: string; presentation: string }>;
  } | null> {
    const [session] = await db
      .select({
        state: schema.appaProxySessionsTable.state,
        activeTurnId: schema.appaProxySessionsTable.activeTurnId,
      })
      .from(schema.appaProxySessionsTable)
      .where(sessionScopeWhere(scope))
      .limit(1);
    if (!session) return null;

    const calls = await db
      .select({
        callId: schema.appaProxyCallsTable.callId,
        state: schema.appaProxyCallsTable.state,
        resultPresentation: schema.appaProxyCallsTable.resultPresentation,
      })
      .from(schema.appaProxyCallsTable)
      .where(eq(schema.appaProxyCallsTable.sessionId, scope.sessionId));

    return {
      sessionState: session.state,
      activeTurnId: session.activeTurnId,
      outstandingCallCount: calls.filter((call) =>
        ["authorization_intent", "open", "result_intent"].includes(call.state),
      ).length,
      safePresentations: calls.flatMap((call) =>
        call.state === "result_admitted" && call.resultPresentation !== null
          ? [{ callId: call.callId, presentation: call.resultPresentation }]
          : [],
      ),
    };
  }

  static async getInboundState(scope: AppaOpaqueHistoryScope): Promise<{
    windows: OpaqueWindow[];
    items: OpaqueItem[];
  }> {
    const [session] = await db
      .select({ id: schema.appaProxySessionsTable.id })
      .from(schema.appaProxySessionsTable)
      .where(sessionScopeWhere(scope))
      .limit(1);
    if (!session) throw new AppaOpaqueHistoryModelError("unknown_session");

    const windows = await db
      .select()
      .from(schema.appaOpaqueHistoryWindowsTable)
      .where(windowScopeWhere(scope))
      .orderBy(asc(schema.appaOpaqueHistoryWindowsTable.frameVersion));
    if (windows.length === 0) return { windows, items: [] };

    const items = await db
      .select()
      .from(schema.appaOpaqueHistoryItemsTable)
      .where(
        and(
          itemScopeWhere(scope),
          inArray(
            schema.appaOpaqueHistoryItemsTable.windowId,
            windows.map((window) => window.id),
          ),
        ),
      );
    return { windows, items };
  }

  static async bindCompactionSuccessor(params: {
    scope: AppaOpaqueHistoryScope;
    sourceWindow: AppaOpaqueHistoryWindowRef;
    tokenServerIdentity: string;
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      await lockSession({ tx, scope: params.scope });
      const windows = await tx
        .select()
        .from(schema.appaOpaqueHistoryWindowsTable)
        .where(windowScopeWhere(params.scope))
        .for("update");
      const existing = findWindow(windows, params.sourceWindow);
      const [token] = await tx
        .select()
        .from(schema.appaOpaqueHistoryItemsTable)
        .where(
          and(
            itemScopeWhere(params.scope),
            eq(
              schema.appaOpaqueHistoryItemsTable.serverIdentity,
              params.tokenServerIdentity,
            ),
          ),
        )
        .limit(1);
      if (!token || token.itemType !== "compaction") {
        throw new AppaOpaqueHistoryModelError("unknown_item");
      }
      const parent = windows.find((window) => window.id === token.windowId);
      if (!parent)
        throw new AppaOpaqueHistoryModelError("window_lineage_changed");
      if (params.sourceWindow.frameVersion !== parent.frameVersion + 1) {
        throw new AppaOpaqueHistoryModelError("window_lineage_changed");
      }

      if (existing) {
        if (
          existing.parentWindowId !== parent.id ||
          existing.boundByServerIdentity !== params.tokenServerIdentity
        ) {
          throw new AppaOpaqueHistoryModelError("window_lineage_changed");
        }
        return;
      }
      if (
        windows.some(
          (window) =>
            window.boundByServerIdentity === params.tokenServerIdentity,
        )
      ) {
        throw new AppaOpaqueHistoryModelError("window_lineage_changed");
      }
      await tx.insert(schema.appaOpaqueHistoryWindowsTable).values({
        sessionId: params.scope.sessionId,
        provider: params.scope.provider,
        protocol: params.scope.protocol,
        model: params.scope.model,
        providerWindowId: params.sourceWindow.providerWindowId,
        frameVersion: params.sourceWindow.frameVersion,
        sourceTurnId: params.sourceWindow.sourceTurnId,
        parentWindowId: parent.id,
        boundByServerIdentity: params.tokenServerIdentity,
      });
    });
  }

  static async recordIssuedItems(params: {
    scope: AppaOpaqueHistoryScope;
    trigger?: AppaOpaqueHistoryTrigger;
    sourceWindow: AppaOpaqueHistoryWindowRef;
    items: IssuedItem[];
    maxItems: number;
    maxBytes: number;
    requireCompactionReady: boolean;
  }): Promise<void> {
    if (params.items.length === 0) return;
    await withDbTransaction(async (tx) => {
      const session = await lockSession({ tx, scope: params.scope });
      if (
        params.requireCompactionReady &&
        params.trigger === "manual" &&
        session.state !== "ready"
      ) {
        throw new AppaOpaqueHistoryModelError("manual_turn_active");
      }
      if (params.requireCompactionReady) {
        const outstanding = await tx
          .select({ id: schema.appaProxyCallsTable.id })
          .from(schema.appaProxyCallsTable)
          .where(
            and(
              eq(schema.appaProxyCallsTable.sessionId, params.scope.sessionId),
              inArray(schema.appaProxyCallsTable.state, [
                "authorization_intent",
                "open",
                "result_intent",
              ]),
            ),
          )
          .limit(1);
        if (outstanding.length > 0)
          throw new AppaOpaqueHistoryModelError("outstanding_calls");
      }

      const sourceWindow = await ensureIssuedSourceWindow({
        tx,
        scope: params.scope,
        window: params.sourceWindow,
      });
      const [{ itemCount, itemBytes }] = await tx
        .select({
          itemCount: sql<number>`count(*)::int`,
          itemBytes: sql<number>`coalesce(sum(${schema.appaOpaqueHistoryItemsTable.canonicalPayloadBytes}), 0)::int`,
        })
        .from(schema.appaOpaqueHistoryItemsTable)
        .where(
          eq(
            schema.appaOpaqueHistoryItemsTable.sessionId,
            params.scope.sessionId,
          ),
        );
      const newBytes = params.items.reduce(
        (total, item) => total + item.canonicalPayloadBytes,
        0,
      );
      if (
        itemCount + params.items.length > params.maxItems ||
        itemBytes + newBytes > params.maxBytes
      ) {
        throw new AppaOpaqueHistoryModelError("storage_limit");
      }

      for (const item of params.items) {
        const existing = await tx
          .select({ id: schema.appaOpaqueHistoryItemsTable.id })
          .from(schema.appaOpaqueHistoryItemsTable)
          .where(
            and(
              itemScopeWhere(params.scope),
              eq(
                schema.appaOpaqueHistoryItemsTable.identityHash,
                item.identityHash,
              ),
            ),
          )
          .limit(1);
        if (existing.length > 0)
          throw new AppaOpaqueHistoryModelError("duplicate_item");
      }

      await tx.insert(schema.appaOpaqueHistoryItemsTable).values(
        params.items.map((item) => ({
          sessionId: params.scope.sessionId,
          windowId: sourceWindow.id,
          provider: params.scope.provider,
          protocol: params.scope.protocol,
          model: params.scope.model,
          providerItemId: item.providerItemId,
          serverIdentity: item.serverIdentity,
          itemType: item.itemType,
          sourceTurnId: params.sourceWindow.sourceTurnId,
          identityHash: item.identityHash,
          canonicalPayloadEncrypted: item.canonicalPayloadEncrypted,
          canonicalPayloadBytes: item.canonicalPayloadBytes,
        })),
      );
    });
  }
}

export class AppaOpaqueHistoryModelError extends Error {
  constructor(
    readonly code:
      | "unknown_session"
      | "unknown_item"
      | "manual_turn_active"
      | "outstanding_calls"
      | "storage_limit"
      | "duplicate_item"
      | "window_lineage_changed",
  ) {
    super(code);
    this.name = "AppaOpaqueHistoryModelError";
  }
}

export default AppaOpaqueHistoryModel;

// === Internal helpers ===

function sessionScopeWhere(scope: AppaOpaqueHistoryScope) {
  return and(
    eq(schema.appaProxySessionsTable.id, scope.sessionId),
    eq(schema.appaProxySessionsTable.ownerScopeHash, scope.ownerScopeHash),
  );
}

function windowScopeWhere(scope: AppaOpaqueHistoryScope) {
  return and(
    eq(schema.appaOpaqueHistoryWindowsTable.sessionId, scope.sessionId),
    eq(schema.appaOpaqueHistoryWindowsTable.provider, scope.provider),
    eq(schema.appaOpaqueHistoryWindowsTable.protocol, scope.protocol),
    eq(schema.appaOpaqueHistoryWindowsTable.model, scope.model),
  );
}

function itemScopeWhere(scope: AppaOpaqueHistoryScope) {
  return and(
    eq(schema.appaOpaqueHistoryItemsTable.sessionId, scope.sessionId),
    eq(schema.appaOpaqueHistoryItemsTable.provider, scope.provider),
    eq(schema.appaOpaqueHistoryItemsTable.protocol, scope.protocol),
    eq(schema.appaOpaqueHistoryItemsTable.model, scope.model),
  );
}

async function lockSession(params: {
  tx: Parameters<Parameters<typeof withDbTransaction>[0]>[0];
  scope: AppaOpaqueHistoryScope;
}) {
  const [session] = await params.tx
    .select({
      id: schema.appaProxySessionsTable.id,
      state: schema.appaProxySessionsTable.state,
    })
    .from(schema.appaProxySessionsTable)
    .where(sessionScopeWhere(params.scope))
    .for("update")
    .limit(1);
  if (!session) throw new AppaOpaqueHistoryModelError("unknown_session");
  return session;
}

async function ensureIssuedSourceWindow(params: {
  tx: Parameters<Parameters<typeof withDbTransaction>[0]>[0];
  scope: AppaOpaqueHistoryScope;
  window: AppaOpaqueHistoryWindowRef;
}): Promise<OpaqueWindow> {
  const windows = await params.tx
    .select()
    .from(schema.appaOpaqueHistoryWindowsTable)
    .where(windowScopeWhere(params.scope))
    .for("update");
  const existing = findWindow(windows, params.window);
  if (existing) return existing;
  if (windows.length !== 0) {
    throw new AppaOpaqueHistoryModelError("window_lineage_changed");
  }
  const [created] = await params.tx
    .insert(schema.appaOpaqueHistoryWindowsTable)
    .values({
      sessionId: params.scope.sessionId,
      provider: params.scope.provider,
      protocol: params.scope.protocol,
      model: params.scope.model,
      providerWindowId: params.window.providerWindowId,
      frameVersion: params.window.frameVersion,
      sourceTurnId: params.window.sourceTurnId,
      parentWindowId: null,
    })
    .returning();
  if (!created)
    throw new Error("failed to create opaque history source window");
  return created;
}

function findWindow(
  windows: OpaqueWindow[],
  ref: AppaOpaqueHistoryWindowRef,
): OpaqueWindow | undefined {
  const window = windows.find(
    (candidate) => candidate.providerWindowId === ref.providerWindowId,
  );
  if (window && window.frameVersion !== ref.frameVersion) {
    throw new AppaOpaqueHistoryModelError("window_lineage_changed");
  }
  return window;
}
