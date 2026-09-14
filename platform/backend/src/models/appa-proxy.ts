import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import { AppaProxySessionProtocolError } from "./appa-proxy-session";

export type AppaProxyLedgerScope = {
  sessionId: string;
  ownerScopeHash: string;
  profileId: string;
};
/** @public — repository scope type */
export type AppaProxyRepositoryScope = AppaProxyLedgerScope;

export type AppaProxyForkLookupScope = Omit<AppaProxyLedgerScope, "sessionId">;
/** @public — repository fork lookup scope type */
export type AppaProxyRepositoryForkLookupScope = AppaProxyForkLookupScope;

/**
 * Correlation-only persistence for runtime checkpoints and provider client
 * identities. Runtime receipt, call, dispatch, and spawn policy state stays in
 * the native runtime and the existing APPA session models.
 */
export default class AppaProxyLedgerModel {
  static async findSingleCall(
    params: AppaProxyLedgerScope & { callId: string },
  ) {
    const [row] = await db
      .select({
        callId: schema.appaProxyCallsTable.callId,
        dispatchId: schema.appaProxyCallsTable.dispatchId,
        spawnBinding: schema.appaProxyCallsTable.spawnBinding,
        state: schema.appaProxyCallsTable.state,
        emittedArgumentsCanonical:
          schema.appaProxyCallsTable.emittedArgumentsCanonical,
      })
      .from(schema.appaProxyCallsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxyCallsTable.sessionId,
          schema.appaProxySessionsTable.id,
        ),
      )
      .where(
        and(
          ownedSessionWhere(params),
          eq(schema.appaProxyCallsTable.callId, params.callId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findOwnedFrame(
    params: AppaProxyLedgerScope & { frameId: string },
  ) {
    const [row] = await db
      .select({
        id: schema.appaProxyWireFramesTable.id,
        sessionId: schema.appaProxyWireFramesTable.sessionId,
        receiptHash: schema.appaProxyWireFramesTable.receiptHash,
        state: schema.appaProxyWireFramesTable.state,
      })
      .from(schema.appaProxyWireFramesTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxyWireFramesTable.sessionId,
          schema.appaProxySessionsTable.id,
        ),
      )
      .where(
        and(
          ownedSessionWhere(params),
          eq(schema.appaProxyWireFramesTable.id, params.frameId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async createCheckpointBinding(
    params: AppaProxyLedgerScope & {
      sourceFrameId: string;
      runtimeEventId: string;
      checkpointId: string;
      checkpointPosition: number;
      checkpointDigest: string;
      provider: string;
      protocol: string;
      model: string;
      bootstrapDigest: string | null;
      requestPrefixHash: string;
      inheritedPrefixHash: string;
      historyCiphertext: string;
      historyHash: string;
      historyBytes: number;
      issuedItemsDigest: string;
      actualResponseHash: string;
      terminalOmission: boolean;
    },
  ) {
    const frame = await AppaProxyLedgerModel.findOwnedFrame({
      ...params,
      frameId: params.sourceFrameId,
    });
    if (
      !frame ||
      !frame.receiptHash ||
      frame.receiptHash !== params.actualResponseHash ||
      frame.state !== "completed"
    ) {
      throw new AppaProxySessionProtocolError(
        "checkpoint binding requires an owned encrypted response receipt",
      );
    }
    const values = {
      sourceSessionId: params.sessionId,
      sourceFrameId: params.sourceFrameId,
      runtimeEventId: params.runtimeEventId,
      checkpointId: params.checkpointId,
      checkpointPosition: params.checkpointPosition,
      checkpointDigest: params.checkpointDigest,
      provider: params.provider,
      protocol: params.protocol,
      model: params.model,
      bootstrapDigest: params.bootstrapDigest,
      requestPrefixHash: params.requestPrefixHash,
      inheritedPrefixHash: params.inheritedPrefixHash,
      historyCiphertext: params.historyCiphertext,
      historyHash: params.historyHash,
      historyBytes: params.historyBytes,
      issuedItemsDigest: params.issuedItemsDigest,
      actualResponseHash: params.actualResponseHash,
      terminalOmission: params.terminalOmission,
    };
    const [created] = await db
      .insert(schema.appaProxyCheckpointBindingsTable)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  }

  static async findCheckpointBinding(
    params: AppaProxyLedgerScope & {
      checkpointId: string;
    },
  ) {
    const [row] = await db
      .select({ binding: schema.appaProxyCheckpointBindingsTable })
      .from(schema.appaProxyCheckpointBindingsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxyCheckpointBindingsTable.sourceSessionId,
          schema.appaProxySessionsTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.appaProxyCheckpointBindingsTable.sourceSessionId,
            params.sessionId,
          ),
          eq(
            schema.appaProxyCheckpointBindingsTable.checkpointId,
            params.checkpointId,
          ),
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
        ),
      )
      .limit(1);
    return row?.binding ?? null;
  }

  static async listCheckpointBindings(
    params: Omit<AppaProxyLedgerScope, "sessionId"> & {
      provider: string;
      protocol: string;
      model: string;
      bootstrapDigest: string | null;
    },
  ) {
    return await db
      .select({ binding: schema.appaProxyCheckpointBindingsTable })
      .from(schema.appaProxyCheckpointBindingsTable)
      .innerJoin(
        schema.appaProxySessionsTable,
        eq(
          schema.appaProxyCheckpointBindingsTable.sourceSessionId,
          schema.appaProxySessionsTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.appaProxySessionsTable.ownerScopeHash,
            params.ownerScopeHash,
          ),
          eq(schema.appaProxySessionsTable.profileId, params.profileId),
          eq(schema.appaProxyCheckpointBindingsTable.provider, params.provider),
          eq(schema.appaProxyCheckpointBindingsTable.protocol, params.protocol),
          eq(schema.appaProxyCheckpointBindingsTable.model, params.model),
          params.bootstrapDigest === null
            ? isNull(schema.appaProxyCheckpointBindingsTable.bootstrapDigest)
            : eq(
                schema.appaProxyCheckpointBindingsTable.bootstrapDigest,
                params.bootstrapDigest,
              ),
          eq(schema.appaProxyCheckpointBindingsTable.state, "bound"),
        ),
      );
  }
}

/** @public — repository model alias for AppaProxyLedgerModel */
export { AppaProxyLedgerModel as AppaProxyRepositoryModel };

function ownedSessionWhere(scope: AppaProxyLedgerScope) {
  return and(
    eq(schema.appaProxySessionsTable.id, scope.sessionId),
    eq(schema.appaProxySessionsTable.ownerScopeHash, scope.ownerScopeHash),
    eq(schema.appaProxySessionsTable.profileId, scope.profileId),
  );
}
