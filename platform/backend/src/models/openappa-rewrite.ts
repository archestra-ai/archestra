import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import db from "@/database";
import { openappaSessionsTable } from "@/database/schemas/openappa";
import {
  openappaRewriteGroupsTable,
  openappaRewriteHeadsTable,
  openappaRewritePairsTable,
  openappaRewriteRootsTable,
} from "@/database/schemas/openappa-rewrite";
import { openappaActor } from "@/openappa/actor";
import { ApiError } from "@/types";
import {
  OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS,
  OPENAPPA_REWRITE_DEFAULT_MAX_BYTES,
  OPENAPPA_REWRITE_DEFAULT_MAX_ENTRIES,
  OPENAPPA_REWRITE_DEFAULT_SWEEP_BATCH,
  OPENAPPA_REWRITE_MAX_BATCH,
  OPENAPPA_REWRITE_MAX_BYTES,
  OPENAPPA_REWRITE_MAX_ENTRIES,
  OPENAPPA_REWRITE_MAX_FORK_DEPTH,
  OPENAPPA_REWRITE_MAX_HEAD_BYTES,
  OPENAPPA_REWRITE_MAX_IDLE_TTL_MS,
  OPENAPPA_REWRITE_MAX_KEY_LENGTH,
  OPENAPPA_REWRITE_MAX_PAIR_BYTES,
  OPENAPPA_REWRITE_MAX_SWEEP_BATCH,
  OPENAPPA_REWRITE_MAX_WIRE_LENGTH,
  OPENAPPA_REWRITE_PROTOCOL_VERSION,
  OPENAPPA_REWRITE_TOUCH_SLACK_MS,
  type OpenAppaRewriteExistingInput,
  type OpenAppaRewriteHead,
  type OpenAppaRewriteOpenInput,
  type OpenAppaRewritePair,
  type OpenAppaRewriteReservation,
  type OpenAppaRewriteScope,
  type OpenAppaRewriteStatus,
} from "@/types/openappa-rewrite";
import { normalizeByteaField } from "@/utils/normalize-bytea";

const groups = openappaRewriteGroupsTable;
const pairs = openappaRewritePairsTable;
const heads = openappaRewriteHeadsTable;
const roots = openappaRewriteRootsTable;
const sessions = openappaSessionsTable;

const EXPIRED_MESSAGE = "Replay retention expired";
const SCOPE_CONFLICT_MESSAGE = "Replay scope conflict";
const RECORD_CONFLICT_MESSAGE = "Replay record conflict";
const LIMIT_MESSAGE = "Replay record limit exceeded";

type RewriteTx = Pick<typeof db, "select" | "insert" | "update" | "execute">;

type NativeSession = {
  sessionId: string;
  root: string;
  forkedFrom: string | null;
};

type GroupRow = {
  organizationId: string;
  groupId: string;
  epoch: number;
  protocolVersion: number;
  status: OpenAppaRewriteStatus;
  idleTtlMs: number;
  expiresAt: Date;
  entryCount: number;
  byteCount: number;
  maxEntries: number;
  maxBytes: number;
  payloadSweptAt: Date | null;
};

type LiveGate = {
  status: "live";
  scope: OpenAppaRewriteScope;
  sessionId: string;
  entryCount: number;
  byteCount: number;
  maxEntries: number;
  maxBytes: number;
};

type Gate = LiveGate | { status: "expired" } | { status: "conflict" };

type PreparedPair = {
  fragmentKey: string;
  original: Buffer;
  rewritten: Buffer;
  originalDigest: string;
  rewrittenDigest: string;
  byteLen: number;
};

type Enrollment =
  | { kind: "conflict" }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "slow" }
  | { kind: "healthy"; scope: OpenAppaRewriteScope };

type Snapshot = {
  kind: "conflict" | "expired" | "slow" | "live";
  now: Date;
  row: GroupRow | null;
  pairs: Map<string, OpenAppaRewritePair>;
  head: OpenAppaRewriteHead | null;
  headInitialized: boolean;
};

/** @public — durable OpenAPPA rewrite pairs for protocol integration. */
export default class OpenAppaRewriteModel {
  static async ancestorSessionIds(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
  }): Promise<string[]> {
    assertIdentity(params.organizationId, params.sessionId);
    const result = await db.execute<{
      sessionId: string;
      actor: string | null;
      parentId: string | null;
      forkedFrom: string | null;
      callerId: string | null;
    }>(sql`
      WITH RECURSIVE ancestors(session_id) AS (
        SELECT ${params.sessionId}::text
        UNION
        SELECT link.session_id
        FROM ancestors a
        JOIN openappa_sessions s
          ON s.organization_id = ${params.organizationId}
         AND s.actor = 'archestra:' || encode(sha256(convert_to(a.session_id, 'UTF8')), 'hex')
         AND s.session_id = a.session_id
        CROSS JOIN LATERAL unnest(ARRAY[s.parent_id, s.forked_from]) link(session_id)
        WHERE link.session_id IS NOT NULL
      )
      SELECT a.session_id AS "sessionId", s.actor,
        s.parent_id AS "parentId", s.forked_from AS "forkedFrom",
        s.caller_id AS "callerId"
      FROM ancestors a
      LEFT JOIN openappa_sessions s
        ON s.organization_id = ${params.organizationId}
       AND s.actor = 'archestra:' || encode(sha256(convert_to(a.session_id, 'UTF8')), 'hex')
       AND s.session_id = a.session_id
      LIMIT ${OPENAPPA_REWRITE_MAX_FORK_DEPTH + 1}
    `);
    if (result.rows.length > OPENAPPA_REWRITE_MAX_FORK_DEPTH)
      throw scopeConflict();
    const byId = new Map(result.rows.map((row) => [row.sessionId, row]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw scopeConflict();
      if (visited.has(id)) return;
      const row = byId.get(id);
      if (
        !row ||
        row.actor !== openappaActor(id) ||
        row.callerId !== (params.callerId ?? null)
      )
        throw scopeConflict();
      visiting.add(id);
      for (const ancestor of [row.parentId, row.forkedFrom]) {
        if (ancestor) visit(ancestor);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(params.sessionId);
    visited.delete(params.sessionId);
    return [...visited];
  }

  static async open(
    params: OpenAppaRewriteOpenInput,
  ): Promise<OpenAppaRewriteScope> {
    const limits = creationLimits(params);
    const enrolled = await readEnrollment(
      params.organizationId,
      params.sessionId,
      params.now,
    );
    if (enrolled.kind === "healthy") return enrolled.scope;
    if (enrolled.kind === "expired") throw expiredError();
    if (enrolled.kind === "conflict") throw scopeConflict();
    const outcome = await db.transaction(async (tx) => {
      const now = await resolveNow(tx, params.now);
      const session = await loadSession(
        tx,
        params.organizationId,
        params.sessionId,
      );
      if (!session) return conflictGate();
      const groupId = await resolveGroup(tx, params.organizationId, session);
      await tx
        .insert(groups)
        .values({
          organizationId: params.organizationId,
          groupId,
          epoch: 1,
          protocolVersion: OPENAPPA_REWRITE_PROTOCOL_VERSION,
          status: "live",
          idleTtlMs: limits.idleTtlMs,
          expiresAt: leaseEnd(now, limits.idleTtlMs),
          touchedAt: now,
          entryCount: 0,
          byteCount: 0,
          maxEntries: limits.maxEntries,
          maxBytes: limits.maxBytes,
        })
        .onConflictDoNothing();
      const row = await lockGroup(tx, params.organizationId, groupId);
      if (!row) return conflictGate();
      return settleGroup(tx, row, session, now);
    });
    return unwrap(outcome);
  }

  static async openExisting(
    params: OpenAppaRewriteExistingInput,
  ): Promise<OpenAppaRewriteScope> {
    assertProtocol(params.protocolVersion);
    assertIdentity(params.organizationId, params.sessionId);
    assertNow(params.now);
    const enrolled = await readEnrollment(
      params.organizationId,
      params.sessionId,
      params.now,
    );
    if (enrolled.kind === "healthy") return enrolled.scope;
    if (enrolled.kind === "expired") throw expiredError();
    if (enrolled.kind === "conflict") throw scopeConflict();
    const outcome = await db.transaction(async (tx) => {
      const now = await resolveNow(tx, params.now);
      const session = await loadSession(
        tx,
        params.organizationId,
        params.sessionId,
      );
      if (!session) return conflictGate();
      const groupId = await resolveGroup(tx, params.organizationId, session);
      const row = await lockGroup(tx, params.organizationId, groupId);
      if (!row) throw scopeConflict();
      return settleGroup(tx, row, session, now);
    });
    return unwrap(outcome);
  }

  static async verify(
    scope: OpenAppaRewriteScope,
    options?: { now?: Date },
  ): Promise<OpenAppaRewriteScope> {
    assertScope(scope);
    assertNow(options?.now);
    const snap = await readScope(scope, {
      now: options?.now,
      lock: false,
    });
    if (snap.kind === "live" && snap.row) {
      return liveScope(scope, snap.row, snap.row.expiresAt);
    }
    if (snap.kind === "expired") throw expiredError();
    if (snap.kind === "conflict") throw scopeConflict();
    const outcome = await db.transaction(async (tx) => {
      const locked = await readScope(scope, {
        now: options?.now,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") return { status: "expired" as const };
      if (locked.kind !== "live" || !locked.row) return conflictGate();
      return settleGroup(tx, locked.row, sessionFrom(scope), locked.now);
    });
    return unwrap(outcome);
  }

  static async loadBatch(
    scope: OpenAppaRewriteScope,
    keys: readonly string[],
    options?: { now?: Date },
  ): Promise<OpenAppaRewritePair[]> {
    assertScope(scope);
    assertNow(options?.now);
    if (keys.length > OPENAPPA_REWRITE_MAX_BATCH) throw limitError();
    const ordered = uniqueKeys(keys);
    const snap = await readScope(scope, {
      now: options?.now,
      keys: ordered,
      lock: false,
    });
    if (snap.kind === "expired") throw expiredError();
    if (snap.kind === "conflict") throw scopeConflict();
    if (snap.kind === "live") return pairsInOrder(ordered, snap.pairs);
    const outcome = await db.transaction(async (tx) => {
      const locked = await readScope(scope, {
        now: options?.now,
        keys: ordered,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") return { status: "expired" as const };
      if (locked.kind !== "live" || !locked.row) return conflictGate();
      const settled = await settleGroup(
        tx,
        locked.row,
        sessionFrom(scope),
        locked.now,
      );
      if (settled.status !== "live") return settled;
      return {
        status: "live" as const,
        pairs: pairsInOrder(ordered, locked.pairs),
      };
    });
    if (outcome.status === "live") return outcome.pairs;
    throw outcome.status === "expired" ? expiredError() : scopeConflict();
  }

  static async appendBatch(
    scope: OpenAppaRewriteScope,
    batch: readonly OpenAppaRewritePair[],
    options?: { now?: Date },
  ): Promise<OpenAppaRewritePair[]> {
    assertScope(scope);
    assertNow(options?.now);
    if (batch.length > OPENAPPA_REWRITE_MAX_BATCH) throw limitError();
    const prepared = prepareBatch(batch);
    const outcome = await db.transaction(async (tx) => {
      const locked = await readScope(scope, {
        now: options?.now,
        keys: prepared.map((pair) => pair.fragmentKey),
        lock: true,
        tx,
      });
      if (locked.kind === "expired") return { status: "expired" as const };
      if (locked.kind !== "live" || !locked.row) return conflictGate();
      const settled = await settleGroup(
        tx,
        locked.row,
        sessionFrom(scope),
        locked.now,
      );
      if (settled.status !== "live") return settled;
      const pairs = await writePairs(tx, settled, prepared, locked.pairs);
      return { status: "live" as const, pairs };
    });
    if (outcome.status === "live") return outcome.pairs;
    throw outcome.status === "expired" ? expiredError() : scopeConflict();
  }

  /** Commit a charged, single-use slot; no transaction survives this call. */
  static async reservePair(params: {
    scope: OpenAppaRewriteScope;
    pair: OpenAppaRewritePair;
    reservationId: string;
    maxBytes: number;
    now?: Date;
  }): Promise<OpenAppaRewriteReservation> {
    assertScope(params.scope);
    assertNow(params.now);
    const pair = preparePair(params.pair);
    if (
      !/^[0-9a-f-]{36}$/.test(params.reservationId) ||
      !Number.isSafeInteger(params.maxBytes) ||
      params.maxBytes < pair.byteLen ||
      params.maxBytes > 2 * OPENAPPA_REWRITE_MAX_PAIR_BYTES
    )
      throw limitError();
    return db.transaction(async (tx) => {
      const locked = await readScope(params.scope, {
        now: params.now,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") throw expiredError();
      if (locked.kind !== "live" || !locked.row) throw scopeConflict();
      const gate = await settleGroup(
        tx,
        locked.row,
        sessionFrom(params.scope),
        locked.now,
      );
      if (gate.status !== "live") throw expiredError();
      const [existing] = await tx
        .select({ key: pairs.fragmentKey })
        .from(pairs)
        .where(
          and(
            eq(pairs.organizationId, params.scope.organizationId),
            eq(pairs.groupId, params.scope.groupId),
            eq(pairs.sessionId, params.scope.sessionId),
            eq(pairs.fragmentKey, pair.fragmentKey),
          ),
        )
        .limit(1);
      if (existing) throw recordConflict();
      if (
        gate.entryCount >= gate.maxEntries ||
        params.maxBytes > gate.maxBytes - gate.byteCount
      )
        throw limitError();
      const expiresAt = leaseEnd(locked.now, locked.row.idleTtlMs);
      const inserted = await tx
        .insert(pairs)
        .values({
          organizationId: params.scope.organizationId,
          groupId: params.scope.groupId,
          sessionId: params.scope.sessionId,
          fragmentKey: pair.fragmentKey,
          original: pair.original,
          originalDigest: pair.originalDigest,
          rewritten: pair.rewritten,
          rewrittenDigest: pair.rewrittenDigest,
          byteLen: pair.byteLen,
          reservationId: params.reservationId,
          reservedBytes: params.maxBytes - pair.byteLen,
          reservationExpiresAt: expiresAt,
        })
        .onConflictDoNothing()
        .returning({ key: pairs.fragmentKey });
      if (inserted.length !== 1) throw recordConflict();
      await tx
        .update(groups)
        .set({
          entryCount: sql`${groups.entryCount} + 1`,
          byteCount: sql`${groups.byteCount} + ${params.maxBytes}`,
        })
        .where(
          and(
            eq(groups.organizationId, params.scope.organizationId),
            eq(groups.groupId, params.scope.groupId),
          ),
        );
      return {
        scope: gate.scope,
        fragmentKey: pair.fragmentKey,
        reservationId: params.reservationId,
        expiresAt,
      };
    });
  }

  /** Finalize only this reserved slot; normal append can never replace it. */
  static async completeReservation(params: {
    reservation: OpenAppaRewriteReservation;
    reservedPair: OpenAppaRewritePair;
    pair: OpenAppaRewritePair;
    now?: Date;
  }): Promise<OpenAppaRewritePair> {
    const { scope, fragmentKey, reservationId } = params.reservation;
    assertScope(scope);
    assertNow(params.now);
    const prepared = preparePair(params.pair);
    const reserved = preparePair(params.reservedPair);
    if (
      prepared.fragmentKey !== fragmentKey ||
      reserved.fragmentKey !== fragmentKey
    )
      throw recordConflict();
    return db.transaction(async (tx) => {
      const locked = await readScope(scope, {
        now: params.now,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") throw expiredError();
      if (locked.kind !== "live" || !locked.row) throw scopeConflict();
      const gate = await settleGroup(
        tx,
        locked.row,
        sessionFrom(scope),
        locked.now,
      );
      if (gate.status !== "live") throw expiredError();
      const [row] = await tx
        .select()
        .from(pairs)
        .where(
          and(
            eq(pairs.organizationId, scope.organizationId),
            eq(pairs.groupId, scope.groupId),
            eq(pairs.sessionId, scope.sessionId),
            eq(pairs.fragmentKey, fragmentKey),
          ),
        )
        .limit(1);
      if (!row || row.reservationId !== reservationId) throw recordConflict();
      const original = verifiedBytes(row.original, row.originalDigest);
      const rewritten = verifiedBytes(row.rewritten, row.rewrittenDigest);
      if (original.length + rewritten.length !== row.byteLen)
        throw recordConflict();
      if (!row.reservationExpiresAt) {
        if (
          !original.equals(prepared.original) ||
          !rewritten.equals(prepared.rewritten)
        )
          throw recordConflict();
        return params.pair;
      }
      if (asDate(row.reservationExpiresAt).getTime() <= locked.now.getTime())
        throw expiredError();
      if (
        !original.equals(reserved.original) ||
        !rewritten.equals(reserved.rewritten)
      )
        throw recordConflict();
      const charged = row.byteLen + row.reservedBytes;
      if (prepared.byteLen > charged) throw limitError();
      const updated = await tx
        .update(pairs)
        .set({
          original: prepared.original,
          originalDigest: prepared.originalDigest,
          rewritten: prepared.rewritten,
          rewrittenDigest: prepared.rewrittenDigest,
          byteLen: prepared.byteLen,
          reservedBytes: 0,
          reservationExpiresAt: null,
        })
        .where(
          and(
            eq(pairs.organizationId, scope.organizationId),
            eq(pairs.groupId, scope.groupId),
            eq(pairs.sessionId, scope.sessionId),
            eq(pairs.fragmentKey, fragmentKey),
            eq(pairs.reservationId, reservationId),
            isNotNull(pairs.reservationExpiresAt),
          ),
        )
        .returning({ key: pairs.fragmentKey });
      if (updated.length !== 1) throw recordConflict();
      await tx
        .update(groups)
        .set({
          byteCount: sql`${groups.byteCount} - ${charged - prepared.byteLen}`,
        })
        .where(
          and(
            eq(groups.organizationId, scope.organizationId),
            eq(groups.groupId, scope.groupId),
          ),
        );
      return params.pair;
    });
  }

  static async readHead(
    scope: OpenAppaRewriteScope,
    wire: string,
    options?: { now?: Date },
  ): Promise<OpenAppaRewriteHead> {
    assertScope(scope);
    assertWire(wire);
    assertNow(options?.now);
    const snap = await readScope(scope, {
      now: options?.now,
      wire,
      lock: false,
    });
    if (snap.kind === "expired") throw expiredError();
    if (snap.kind === "conflict") throw scopeConflict();
    if (snap.kind === "live" && (!snap.head || snap.headInitialized))
      return snap.head ?? emptyHead(wire);
    const outcome = await db.transaction(async (tx) => {
      const locked = await readScope(scope, {
        now: options?.now,
        wire,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") return { status: "expired" as const };
      if (locked.kind !== "live" || !locked.row) return conflictGate();
      const settled = await settleGroup(
        tx,
        locked.row,
        sessionFrom(scope),
        locked.now,
      );
      if (settled.status !== "live") return settled;
      if (locked.head && !locked.headInitialized) {
        await initializeHead(tx, {
          scope,
          wire,
          state: locked.head.state,
          now: locked.now,
        });
      }
      return {
        status: "live" as const,
        head: locked.head ?? emptyHead(wire),
      };
    });
    if (outcome.status === "live") return outcome.head;
    throw outcome.status === "expired" ? expiredError() : scopeConflict();
  }

  static async compareAndSwapHead(params: {
    scope: OpenAppaRewriteScope;
    wire: string;
    expectedRevision: number;
    state: Buffer;
    now?: Date;
  }): Promise<OpenAppaRewriteHead> {
    assertScope(params.scope);
    assertWire(params.wire);
    assertNow(params.now);
    assertRevision(params.expectedRevision);
    const state = asBytes(params.state, OPENAPPA_REWRITE_MAX_HEAD_BYTES);
    const outcome = await db.transaction(async (tx) => {
      const locked = await readScope(params.scope, {
        now: params.now,
        wire: params.wire,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") return { status: "expired" as const };
      if (locked.kind !== "live" || !locked.row) return conflictGate();
      const settled = await settleGroup(
        tx,
        locked.row,
        sessionFrom(params.scope),
        locked.now,
      );
      if (settled.status !== "live") return settled;
      if (locked.head && !locked.headInitialized) {
        await initializeHead(tx, {
          scope: params.scope,
          wire: params.wire,
          state: locked.head.state,
          now: locked.now,
        });
      }
      const head = await swapHead(tx, {
        scope: params.scope,
        wire: params.wire,
        expectedRevision: params.expectedRevision,
        state,
        stateDigest: digestOf(state),
        now: locked.now,
      });
      return { status: "live" as const, head };
    });
    if (outcome.status === "live") return outcome.head;
    throw outcome.status === "expired" ? expiredError() : scopeConflict();
  }

  /** @public — pair insert and head CAS in one group lock. */
  static async commitProjection(params: {
    scope: OpenAppaRewriteScope;
    wire: string;
    expectedRevision: number;
    state?: Buffer;
    pairs: readonly OpenAppaRewritePair[];
    now?: Date;
  }): Promise<{ pairs: OpenAppaRewritePair[]; head: OpenAppaRewriteHead }> {
    assertScope(params.scope);
    assertWire(params.wire);
    assertNow(params.now);
    assertRevision(params.expectedRevision);
    if (params.pairs.length > OPENAPPA_REWRITE_MAX_BATCH) throw limitError();
    const prepared = prepareBatch(params.pairs);
    const state =
      params.state === undefined
        ? undefined
        : asBytes(params.state, OPENAPPA_REWRITE_MAX_HEAD_BYTES);
    const stateDigest = state ? digestOf(state) : undefined;
    return db.transaction(async (tx) => {
      const locked = await readScope(params.scope, {
        now: params.now,
        wire: params.wire,
        lock: true,
        tx,
      });
      if (locked.kind === "expired") throw expiredError();
      if (locked.kind !== "live" || !locked.row) throw scopeConflict();
      const settled = await settleGroup(
        tx,
        locked.row,
        sessionFrom(params.scope),
        locked.now,
      );
      if (settled.status === "expired") throw expiredError();
      if (settled.status !== "live") throw scopeConflict();
      const current = locked.head?.revision ?? 0;
      if (current !== params.expectedRevision) throw recordConflict();
      if (current === 0 && !state) throw recordConflict();
      if (locked.head && !locked.headInitialized) {
        await initializeHead(tx, {
          scope: params.scope,
          wire: params.wire,
          state: locked.head.state,
          now: locked.now,
        });
        const refreshed = await lockGroup(
          tx,
          params.scope.organizationId,
          params.scope.groupId,
        );
        if (!refreshed) throw scopeConflict();
        settled.entryCount = refreshed.entryCount;
        settled.byteCount = refreshed.byteCount;
      }
      const existing =
        prepared.length === 0
          ? new Map<string, OpenAppaRewritePair>()
          : await readPairs(
              tx,
              settled,
              prepared.map((pair) => pair.fragmentKey),
            );
      const stored = await writePairs(tx, settled, prepared, existing);
      const head = state
        ? await swapHead(tx, {
            scope: params.scope,
            wire: params.wire,
            expectedRevision: params.expectedRevision,
            state,
            stateDigest: stateDigest ?? digestOf(state),
            now: locked.now,
          })
        : (locked.head ?? emptyHead(params.wire));
      return { pairs: stored, head };
    });
  }

  static async expireInactive(params?: {
    now?: Date;
    batchSize?: number;
  }): Promise<number> {
    const batchSize = sweepBatch(params?.batchSize);
    assertNow(params?.now);
    const due = await db
      .select({
        organizationId: groups.organizationId,
        groupId: groups.groupId,
      })
      .from(groups)
      .where(
        and(
          eq(groups.status, "live"),
          params?.now
            ? lte(groups.expiresAt, params.now)
            : lte(groups.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(groups.expiresAt)
      .limit(batchSize);
    for (const candidate of due) {
      await db.transaction(async (tx) => {
        const locked = await lockSweepGroup(tx, candidate, params?.now, true);
        if (!locked || locked.status !== "live") return;
        if (locked.expiresAt.getTime() > locked.now.getTime()) return;
        if (await hasPendingNativeWork(tx, locked, locked.now)) {
          await touch(
            tx,
            locked,
            leaseEnd(locked.now, locked.idleTtlMs),
            locked.now,
          );
          return;
        }
        await tx
          .update(groups)
          .set({ status: "expired", expiredAt: locked.now })
          .where(
            and(
              eq(groups.organizationId, locked.organizationId),
              eq(groups.groupId, locked.groupId),
              eq(groups.status, "live"),
              lte(groups.expiresAt, locked.now),
            ),
          );
      });
    }
    const unswept = await db
      .select({
        organizationId: groups.organizationId,
        groupId: groups.groupId,
      })
      .from(groups)
      .where(and(eq(groups.status, "expired"), isNull(groups.payloadSweptAt)))
      .orderBy(groups.expiredAt)
      .limit(batchSize);
    let deleted = 0;
    for (const candidate of unswept) {
      if (deleted >= batchSize) break;
      deleted += await db.transaction(async (tx) => {
        const locked = await lockSweepGroup(tx, candidate, params?.now, false);
        if (!locked || locked.status !== "expired") return 0;
        let count = await deletePayload(tx, {
          organizationId: locked.organizationId,
          groupId: locked.groupId,
          table: "openappa_rewrite_pairs",
          limit: batchSize - deleted,
        });
        if (count < batchSize - deleted) {
          count += await deletePayload(tx, {
            organizationId: locked.organizationId,
            groupId: locked.groupId,
            table: "openappa_rewrite_heads",
            limit: batchSize - deleted - count,
          });
        }
        await markSweptIfEmpty(tx, locked, locked.now);
        return count;
      });
    }
    return deleted;
  }
}

function unwrap(gate: Gate): OpenAppaRewriteScope {
  if (gate.status === "live") return gate.scope;
  throw gate.status === "expired" ? expiredError() : scopeConflict();
}

function conflictGate(): { status: "conflict" } {
  return { status: "conflict" };
}

function emptyHead(wire: string): OpenAppaRewriteHead {
  return { wire, revision: 0, state: Buffer.alloc(0) };
}

function liveScope(
  scope: OpenAppaRewriteScope,
  row: GroupRow,
  expiresAt: Date,
): OpenAppaRewriteScope {
  return {
    organizationId: scope.organizationId,
    sessionId: scope.sessionId,
    root: scope.root,
    groupId: row.groupId,
    epoch: row.epoch,
    protocolVersion: OPENAPPA_REWRITE_PROTOCOL_VERSION,
    expiresAt,
  };
}

function sessionFrom(scope: OpenAppaRewriteScope): NativeSession {
  return {
    sessionId: scope.sessionId,
    root: scope.root,
    forkedFrom: null,
  };
}

async function settleGroup(
  tx: RewriteTx,
  row: GroupRow,
  session: NativeSession,
  now: Date,
): Promise<Gate> {
  if (row.protocolVersion !== OPENAPPA_REWRITE_PROTOCOL_VERSION) {
    return conflictGate();
  }
  if (row.status === "expired") return { status: "expired" };
  if (row.status !== "live") return conflictGate();
  let expiresAt = row.expiresAt;
  const remaining = expiresAt.getTime() - now.getTime();
  const idleTtlMs = row.idleTtlMs;
  if (remaining <= 0) {
    if (!(await hasPendingNativeWork(tx, row, now))) {
      await tx
        .update(groups)
        .set({ status: "expired", expiredAt: now })
        .where(
          and(
            eq(groups.organizationId, row.organizationId),
            eq(groups.groupId, row.groupId),
            eq(groups.status, "live"),
          ),
        );
      return { status: "expired" };
    }
    expiresAt = leaseEnd(now, idleTtlMs);
    await touch(tx, row, expiresAt, now);
  } else if (remaining < idleTtlMs) {
    expiresAt = leaseEnd(now, idleTtlMs);
    await touch(tx, row, expiresAt, now);
  }
  return {
    status: "live",
    scope: {
      organizationId: row.organizationId,
      sessionId: session.sessionId,
      root: session.root,
      groupId: row.groupId,
      epoch: row.epoch,
      protocolVersion: OPENAPPA_REWRITE_PROTOCOL_VERSION,
      expiresAt,
    },
    sessionId: session.sessionId,
    entryCount: row.entryCount,
    byteCount: row.byteCount,
    maxEntries: row.maxEntries,
    maxBytes: row.maxBytes,
  };
}

async function readEnrollment(
  organizationId: string,
  sessionId: string,
  now: Date | undefined,
): Promise<Enrollment> {
  const asOf = now ? sql`${now}::timestamptz` : sql`clock_timestamp()`;
  const result = await db.execute<EnrollmentRow>(sql`
    SELECT
      s.session_id AS "sessionId",
      s.root AS "root",
      r.group_id AS "mappedGroupId",
      g.group_id AS "groupId",
      g.epoch AS "epoch",
      g.protocol_version AS "protocolVersion",
      g.status AS "status",
      g.idle_ttl_ms AS "idleTtlMs",
      g.expires_at AS "expiresAt",
      clk.as_of AS "now"
    FROM openappa_sessions s
    CROSS JOIN LATERAL (SELECT ${asOf} AS as_of) clk
    LEFT JOIN openappa_rewrite_roots r
      ON r.organization_id = s.organization_id
     AND r.native_root = s.root
    LEFT JOIN openappa_rewrite_groups g
      ON g.organization_id = s.organization_id
     AND g.group_id = r.group_id
    WHERE s.organization_id = ${organizationId}
      AND s.actor = ${openappaActor(sessionId)}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row || row.sessionId !== sessionId) return { kind: "conflict" };
  if (!row.mappedGroupId) return { kind: "absent" };
  if (!row.groupId || !row.status || row.epoch == null)
    return { kind: "conflict" };
  if (Number(row.protocolVersion) !== OPENAPPA_REWRITE_PROTOCOL_VERSION) {
    return { kind: "conflict" };
  }
  if (row.status === "expired") return { kind: "expired" };
  if (row.status !== "live") return { kind: "conflict" };
  const expiresAt = asDate(row.expiresAt ?? "");
  const clock = asDate(row.now);
  if (!leaseHealthy(expiresAt, clock, Number(row.idleTtlMs))) {
    return { kind: "slow" };
  }
  return {
    kind: "healthy",
    scope: {
      organizationId,
      sessionId,
      root: row.root,
      groupId: row.groupId,
      epoch: Number(row.epoch),
      protocolVersion: OPENAPPA_REWRITE_PROTOCOL_VERSION,
      expiresAt,
    },
  };
}

async function readScope(
  scope: OpenAppaRewriteScope,
  options: {
    now: Date | undefined;
    keys?: readonly string[];
    wire?: string;
    lock: boolean;
    tx?: RewriteTx;
  },
): Promise<Snapshot> {
  const runner = options.tx ?? db;
  const asOf = options.now
    ? sql`${options.now}::timestamptz`
    : sql`clock_timestamp()`;
  const keys = options.keys && options.keys.length > 0 ? options.keys : null;
  const byteGuard = options.lock
    ? sql`AND g.status = 'live'`
    : sql`
      AND g.status = 'live'
      AND g.expires_at >= clk.as_of + (g.idle_ttl_ms * interval '1 millisecond')
      AND g.expires_at >= clk.as_of + (${OPENAPPA_REWRITE_TOUCH_SLACK_MS}::int * interval '1 millisecond')
    `;
  const pairJoin = keys
    ? sql`
      LEFT JOIN openappa_rewrite_pairs p
        ON p.organization_id = g.organization_id
       AND p.group_id = g.group_id
       AND p.session_id = s.session_id
       AND p.fragment_key = ANY(${textArrayLiteral(keys)}::text[])
       ${byteGuard}
    `
    : sql``;
  const headJoin = options.wire
    ? sql`
      LEFT JOIN openappa_rewrite_heads h
        ON h.organization_id = g.organization_id
       AND h.group_id = g.group_id
       AND h.session_id = s.session_id
       AND h.wire = ${options.wire}
       ${byteGuard}
    `
    : sql``;
  const pairColumns = keys
    ? sql`
      p.fragment_key AS "fragmentKey",
      p.original AS "original",
      p.original_digest AS "originalDigest",
      p.rewritten AS "rewritten",
      p.rewritten_digest AS "rewrittenDigest",
      p.byte_len AS "byteLen",
      p.reservation_expires_at AS "reservationExpiresAt",
    `
    : sql`
      NULL::text AS "fragmentKey",
      NULL::bytea AS "original",
      NULL::text AS "originalDigest",
      NULL::bytea AS "rewritten",
      NULL::text AS "rewrittenDigest",
      NULL::int AS "byteLen",
      NULL::timestamptz AS "reservationExpiresAt",
    `;
  const headColumns = options.wire
    ? sql`
      h.wire AS "wire",
      h.revision AS "revision",
      h.state AS "state",
      h.state_digest AS "stateDigest",
      EXISTS (
        SELECT 1 FROM openappa_rewrite_pairs initialized
        WHERE initialized.organization_id = g.organization_id
          AND initialized.group_id = g.group_id
          AND initialized.session_id = s.session_id
          AND initialized.fragment_key = ${headMarkerKey(options.wire)}
      ) AS "headInitialized"
    `
    : sql`
      NULL::text AS "wire",
      NULL::int AS "revision",
      NULL::bytea AS "state",
      NULL::text AS "stateDigest",
      false AS "headInitialized"
    `;
  const result = await runner.execute<ScopeRow>(sql`
    SELECT
      s.session_id AS "sessionId",
      s.root AS "root",
      g.epoch AS "epoch",
      g.protocol_version AS "protocolVersion",
      g.status AS "status",
      g.idle_ttl_ms AS "idleTtlMs",
      g.expires_at AS "expiresAt",
      g.entry_count AS "entryCount",
      g.byte_count AS "byteCount",
      g.max_entries AS "maxEntries",
      g.max_bytes AS "maxBytes",
      clk.as_of AS "now",
      ${pairColumns}
      ${headColumns}
    FROM openappa_sessions s
    CROSS JOIN LATERAL (SELECT ${asOf} AS as_of) clk
    JOIN openappa_rewrite_roots r
      ON r.organization_id = s.organization_id
     AND r.native_root = s.root
     AND r.group_id = ${scope.groupId}
    JOIN openappa_rewrite_groups g
      ON g.organization_id = s.organization_id
     AND g.group_id = r.group_id
     AND g.epoch = ${scope.epoch}
     AND g.protocol_version = ${scope.protocolVersion}
    ${pairJoin}
    ${headJoin}
    WHERE s.organization_id = ${scope.organizationId}
      AND s.actor = ${openappaActor(scope.sessionId)}
      AND s.session_id = ${scope.sessionId}
      AND s.root = ${scope.root}
    ${options.lock ? sql`FOR UPDATE OF g` : sql``}
  `);
  return interpretScope(result.rows, scope, options.wire, options.lock);
}

function interpretScope(
  rows: ScopeRow[],
  scope: OpenAppaRewriteScope,
  wire: string | undefined,
  lock: boolean,
): Snapshot {
  const raw = rows[0];
  if (!raw || raw.status == null || raw.expiresAt == null) {
    return {
      kind: "conflict",
      now: new Date(0),
      row: null,
      pairs: new Map(),
      head: null,
      headInitialized: false,
    };
  }
  const now = asDate(raw.now);
  const expiresAt = asDate(raw.expiresAt);
  const row: GroupRow = {
    organizationId: scope.organizationId,
    groupId: scope.groupId,
    epoch: Number(raw.epoch),
    protocolVersion: Number(raw.protocolVersion),
    status: raw.status === "expired" ? "expired" : "live",
    idleTtlMs: Number(raw.idleTtlMs),
    expiresAt,
    entryCount: Number(raw.entryCount),
    byteCount: Number(raw.byteCount),
    maxEntries: Number(raw.maxEntries),
    maxBytes: Number(raw.maxBytes),
    payloadSweptAt: null,
  };
  if (raw.status === "expired") {
    return {
      kind: "expired",
      now,
      row,
      pairs: new Map(),
      head: null,
      headInitialized: false,
    };
  }
  if (raw.status !== "live") {
    return {
      kind: "conflict",
      now,
      row: null,
      pairs: new Map(),
      head: null,
      headInitialized: false,
    };
  }
  if (!lock && !leaseHealthy(expiresAt, now, row.idleTtlMs)) {
    return {
      kind: "slow",
      now,
      row,
      pairs: new Map(),
      head: null,
      headInitialized: false,
    };
  }
  return {
    kind: "live",
    now,
    row,
    pairs: collectPairs(rows),
    head: collectHead(rows, wire),
    headInitialized: raw.headInitialized,
  };
}

function collectPairs(rows: ScopeRow[]): Map<string, OpenAppaRewritePair> {
  const found = new Map<string, OpenAppaRewritePair>();
  for (const row of rows) {
    if (row.reservationExpiresAt != null) continue;
    if (!row.fragmentKey || row.original == null || row.rewritten == null)
      continue;
    const original = verifiedBytes(row.original, row.originalDigest ?? "");
    const rewritten = verifiedBytes(row.rewritten, row.rewrittenDigest ?? "");
    if (original.length + rewritten.length !== Number(row.byteLen)) {
      throw recordConflict();
    }
    found.set(row.fragmentKey, {
      fragmentKey: row.fragmentKey,
      original,
      rewritten,
    });
  }
  return found;
}

function collectHead(
  rows: ScopeRow[],
  wire: string | undefined,
): OpenAppaRewriteHead | null {
  if (!wire) return null;
  for (const row of rows) {
    if (row.revision == null || row.state == null) continue;
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw recordConflict();
    return {
      wire,
      revision,
      state: verifiedBytes(row.state, row.stateDigest ?? ""),
    };
  }
  if (rows.some((row) => row.headInitialized)) throw recordConflict();
  return null;
}

function pairsInOrder(
  keys: readonly string[],
  stored: Map<string, OpenAppaRewritePair>,
): OpenAppaRewritePair[] {
  return keys.flatMap((key) => {
    const row = stored.get(key);
    return row ? [row] : [];
  });
}

async function writePairs(
  tx: RewriteTx,
  gate: LiveGate,
  prepared: readonly PreparedPair[],
  existing: Map<string, OpenAppaRewritePair>,
): Promise<OpenAppaRewritePair[]> {
  const fresh = prepared.filter((pair) => !existing.has(pair.fragmentKey));
  for (const pair of prepared) {
    const row = existing.get(pair.fragmentKey);
    if (!row) continue;
    if (
      !row.original.equals(pair.original) ||
      !row.rewritten.equals(pair.rewritten)
    ) {
      throw recordConflict();
    }
  }
  const addedBytes = fresh.reduce((sum, pair) => sum + pair.byteLen, 0);
  if (
    fresh.length > gate.maxEntries - gate.entryCount ||
    addedBytes > gate.maxBytes - gate.byteCount
  ) {
    throw limitError();
  }
  if (fresh.length > 0) {
    const inserted = await tx
      .insert(pairs)
      .values(
        fresh.map((pair) => ({
          organizationId: gate.scope.organizationId,
          groupId: gate.scope.groupId,
          sessionId: gate.scope.sessionId,
          fragmentKey: pair.fragmentKey,
          original: pair.original,
          originalDigest: pair.originalDigest,
          rewritten: pair.rewritten,
          rewrittenDigest: pair.rewrittenDigest,
          byteLen: pair.byteLen,
        })),
      )
      .onConflictDoNothing()
      .returning({
        fragmentKey: pairs.fragmentKey,
        originalDigest: pairs.originalDigest,
        rewrittenDigest: pairs.rewrittenDigest,
      });
    if (inserted.length !== fresh.length) throw recordConflict();
    const insertedByKey = new Map(
      inserted.map((row) => [row.fragmentKey, row]),
    );
    for (const pair of fresh) {
      const row = insertedByKey.get(pair.fragmentKey);
      if (
        !row ||
        row.originalDigest !== pair.originalDigest ||
        row.rewrittenDigest !== pair.rewrittenDigest
      ) {
        throw recordConflict();
      }
    }
    await tx
      .update(groups)
      .set({
        entryCount: sql`${groups.entryCount} + ${inserted.length}`,
        byteCount: sql`${groups.byteCount} + ${addedBytes}`,
      })
      .where(
        and(
          eq(groups.organizationId, gate.scope.organizationId),
          eq(groups.groupId, gate.scope.groupId),
        ),
      );
  }
  return prepared.map((pair) => {
    const row = existing.get(pair.fragmentKey);
    return (
      row ?? {
        fragmentKey: pair.fragmentKey,
        original: pair.original,
        rewritten: pair.rewritten,
      }
    );
  });
}

async function resolveGroup(
  tx: RewriteTx,
  organizationId: string,
  session: NativeSession,
  seen = new Set<string>(),
): Promise<string> {
  const mapped = await readMembership(tx, organizationId, session.root);
  if (mapped) {
    if (!(await lockGroup(tx, organizationId, mapped))) throw scopeConflict();
    return mapped;
  }
  if (
    seen.has(session.sessionId) ||
    seen.size >= OPENAPPA_REWRITE_MAX_FORK_DEPTH
  ) {
    throw scopeConflict();
  }
  seen.add(session.sessionId);
  const forkedFrom =
    session.forkedFrom ??
    (await forkOwnerSource(tx, organizationId, session.root));
  const groupId = forkedFrom
    ? await resolveForkSource(tx, organizationId, forkedFrom, seen)
    : session.root;
  await writeMembership(tx, organizationId, session.root, groupId);
  return groupId;
}

async function resolveForkSource(
  tx: RewriteTx,
  organizationId: string,
  forkedFrom: string,
  seen: Set<string>,
): Promise<string> {
  const source = await loadSession(tx, organizationId, forkedFrom);
  if (!source) throw scopeConflict();
  return resolveGroup(tx, organizationId, source, seen);
}

async function forkOwnerSource(
  tx: RewriteTx,
  organizationId: string,
  root: string,
): Promise<string | null> {
  const owners = await tx
    .select({ forkedFrom: sessions.forkedFrom })
    .from(sessions)
    .where(
      and(
        eq(sessions.organizationId, organizationId),
        eq(sessions.root, root),
        isNotNull(sessions.forkedFrom),
      ),
    )
    .limit(2);
  const source = owners[0]?.forkedFrom ?? null;
  if (!source) return null;
  if (owners.length > 1 && owners[1]?.forkedFrom !== source) {
    throw scopeConflict();
  }
  return source;
}

async function loadSession(
  tx: RewriteTx,
  organizationId: string,
  sessionId: string,
): Promise<NativeSession | null> {
  const [row] = await tx
    .select({
      sessionId: sessions.sessionId,
      root: sessions.root,
      forkedFrom: sessions.forkedFrom,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.organizationId, organizationId),
        eq(sessions.actor, openappaActor(sessionId)),
      ),
    )
    .limit(1);
  if (!row || row.sessionId !== sessionId) return null;
  return row;
}

async function readMembership(
  tx: RewriteTx,
  organizationId: string,
  nativeRoot: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ groupId: roots.groupId })
    .from(roots)
    .where(
      and(
        eq(roots.organizationId, organizationId),
        eq(roots.nativeRoot, nativeRoot),
      ),
    )
    .limit(1);
  return row?.groupId ?? null;
}

async function writeMembership(
  tx: RewriteTx,
  organizationId: string,
  nativeRoot: string,
  groupId: string,
): Promise<void> {
  await tx
    .insert(roots)
    .values({ organizationId, nativeRoot, groupId })
    .onConflictDoNothing();
  const stored = await readMembership(tx, organizationId, nativeRoot);
  if (stored !== groupId) throw scopeConflict();
}

async function lockGroup(
  tx: RewriteTx,
  organizationId: string,
  groupId: string,
): Promise<GroupRow | null> {
  const [row] = await tx
    .select({
      organizationId: groups.organizationId,
      groupId: groups.groupId,
      epoch: groups.epoch,
      protocolVersion: groups.protocolVersion,
      status: groups.status,
      idleTtlMs: groups.idleTtlMs,
      expiresAt: groups.expiresAt,
      entryCount: groups.entryCount,
      byteCount: groups.byteCount,
      maxEntries: groups.maxEntries,
      maxBytes: groups.maxBytes,
      payloadSweptAt: groups.payloadSweptAt,
    })
    .from(groups)
    .where(
      and(
        eq(groups.organizationId, organizationId),
        eq(groups.groupId, groupId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) return null;
  return {
    ...row,
    expiresAt: asDate(row.expiresAt),
    payloadSweptAt: row.payloadSweptAt ? asDate(row.payloadSweptAt) : null,
  };
}

async function lockSweepGroup(
  tx: RewriteTx,
  candidate: { organizationId: string; groupId: string } | null,
  now: Date | undefined,
  live: boolean,
): Promise<(GroupRow & { now: Date }) | null> {
  const asOf = now ? sql`${now}::timestamptz` : sql`clock_timestamp()`;
  const where = candidate
    ? sql`
      organization_id = ${candidate.organizationId}
      AND group_id = ${candidate.groupId}
      AND status = ${live ? "live" : "expired"}
      ${live ? sql`` : sql`AND payload_swept_at IS NULL`}
    `
    : sql`status = 'expired' AND payload_swept_at IS NULL`;
  const order = candidate ? sql`` : sql`ORDER BY expired_at`;
  const result = await tx.execute<SweepRow>(sql`
    SELECT
      organization_id AS "organizationId",
      group_id AS "groupId",
      epoch,
      protocol_version AS "protocolVersion",
      status,
      idle_ttl_ms AS "idleTtlMs",
      expires_at AS "expiresAt",
      entry_count AS "entryCount",
      byte_count AS "byteCount",
      max_entries AS "maxEntries",
      max_bytes AS "maxBytes",
      payload_swept_at AS "payloadSweptAt",
      ${asOf} AS "now"
    FROM openappa_rewrite_groups
    WHERE ${where}
    ${order}
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);
  const row = result.rows[0];
  if (!row) return null;
  if (live && row.status !== "live") return null;
  return {
    organizationId: row.organizationId,
    groupId: row.groupId,
    epoch: Number(row.epoch),
    protocolVersion: Number(row.protocolVersion),
    status: row.status === "expired" ? "expired" : "live",
    idleTtlMs: Number(row.idleTtlMs),
    expiresAt: asDate(row.expiresAt),
    entryCount: Number(row.entryCount),
    byteCount: Number(row.byteCount),
    maxEntries: Number(row.maxEntries),
    maxBytes: Number(row.maxBytes),
    payloadSweptAt: row.payloadSweptAt ? asDate(row.payloadSweptAt) : null,
    now: asDate(row.now),
  };
}

async function touch(
  tx: RewriteTx,
  row: { organizationId: string; groupId: string },
  expiresAt: Date,
  now: Date,
): Promise<void> {
  await tx
    .update(groups)
    .set({ expiresAt, touchedAt: now })
    .where(
      and(
        eq(groups.organizationId, row.organizationId),
        eq(groups.groupId, row.groupId),
        eq(groups.status, "live"),
      ),
    );
}

async function hasPendingNativeWork(
  tx: RewriteTx,
  group: { organizationId: string; groupId: string; idleTtlMs: number },
  now: Date,
): Promise<boolean> {
  const recentAfter = new Date(
    now.getTime() - group.idleTtlMs - OPENAPPA_REWRITE_TOUCH_SLACK_MS,
  );
  const result = await tx.execute(sql`
    WITH RECURSIVE members AS (
      SELECT s.session_id, s.root, 1 AS depth, ARRAY[s.session_id]::text[] AS visited
      FROM openappa_sessions s
      WHERE s.organization_id = ${group.organizationId}
        AND s.root IN (
          SELECT r.native_root
          FROM openappa_rewrite_roots r
          WHERE r.organization_id = ${group.organizationId}
            AND r.group_id = ${group.groupId}
        )
      UNION ALL
      SELECT
        child.session_id,
        child.root,
        members.depth + 1,
        members.visited || child.session_id
      FROM openappa_sessions child
      JOIN members
        ON child.forked_from = members.session_id
       AND child.organization_id = ${group.organizationId}
      WHERE members.depth < ${OPENAPPA_REWRITE_MAX_FORK_DEPTH}
        AND NOT child.session_id = ANY(members.visited)
    )
    SELECT 1 AS pending
    WHERE EXISTS (
      SELECT 1
      FROM openappa_operations o
      WHERE o.organization_id = ${group.organizationId}
        AND o.status = 'pending'
        AND o.created_at >= ${recentAfter}
        AND o.root IN (SELECT root FROM members)
    )
    OR EXISTS (
      SELECT 1 FROM openappa_rewrite_pairs reserved
      WHERE reserved.organization_id = ${group.organizationId}
        AND reserved.group_id = ${group.groupId}
        AND reserved.reservation_expires_at > ${now}
    )
    OR EXISTS (
      SELECT 1
      FROM openappa_processed_results p
      WHERE p.organization_id = ${group.organizationId}
        AND p.status = 'pending'
        AND p.created_at >= ${recentAfter}
        AND p.root IN (SELECT root FROM members)
    )
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function readPairs(
  tx: RewriteTx,
  gate: LiveGate,
  keys: readonly string[],
): Promise<Map<string, OpenAppaRewritePair>> {
  const found = new Map<string, OpenAppaRewritePair>();
  if (keys.length === 0) return found;
  const rows = await tx.execute<{
    fragmentKey: string;
    original: Buffer;
    originalDigest: string;
    rewritten: Buffer;
    rewrittenDigest: string;
    byteLen: number;
    reservationExpiresAt: Date | null;
  }>(sql`
    SELECT
      fragment_key AS "fragmentKey",
      original,
      original_digest AS "originalDigest",
      rewritten,
      rewritten_digest AS "rewrittenDigest",
      byte_len AS "byteLen",
      reservation_expires_at AS "reservationExpiresAt"
    FROM openappa_rewrite_pairs
    WHERE organization_id = ${gate.scope.organizationId}
      AND group_id = ${gate.scope.groupId}
      AND session_id = ${gate.sessionId}
      AND fragment_key = ANY(${textArrayLiteral(keys)}::text[])
  `);
  for (const row of rows.rows) {
    if (row.reservationExpiresAt != null) continue;
    const original = verifiedBytes(row.original, row.originalDigest);
    const rewritten = verifiedBytes(row.rewritten, row.rewrittenDigest);
    if (original.length + rewritten.length !== Number(row.byteLen)) {
      throw recordConflict();
    }
    found.set(row.fragmentKey, {
      fragmentKey: row.fragmentKey,
      original,
      rewritten,
    });
  }
  return found;
}

async function swapHead(
  tx: RewriteTx,
  params: {
    scope: OpenAppaRewriteScope;
    wire: string;
    expectedRevision: number;
    state: Buffer;
    stateDigest: string;
    now: Date;
  },
): Promise<OpenAppaRewriteHead> {
  if (params.expectedRevision === 0) {
    await initializeHead(tx, params);
    const inserted = await tx
      .insert(heads)
      .values({
        organizationId: params.scope.organizationId,
        groupId: params.scope.groupId,
        sessionId: params.scope.sessionId,
        wire: params.wire,
        revision: 1,
        state: params.state,
        stateDigest: params.stateDigest,
        updatedAt: params.now,
      })
      .onConflictDoNothing()
      .returning({ revision: heads.revision });
    if (inserted.length !== 1) throw recordConflict();
    return { wire: params.wire, revision: 1, state: params.state };
  }
  const [updated] = await tx
    .update(heads)
    .set({
      revision: sql`${heads.revision} + 1`,
      state: params.state,
      stateDigest: params.stateDigest,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(heads.organizationId, params.scope.organizationId),
        eq(heads.groupId, params.scope.groupId),
        eq(heads.sessionId, params.scope.sessionId),
        eq(heads.wire, params.wire),
        eq(heads.revision, params.expectedRevision),
      ),
    )
    .returning({ revision: heads.revision });
  if (!updated) throw recordConflict();
  return {
    wire: params.wire,
    revision: updated.revision,
    state: params.state,
  };
}

async function initializeHead(
  tx: RewriteTx,
  params: {
    scope: OpenAppaRewriteScope;
    wire: string;
    state: Buffer;
    now: Date;
  },
): Promise<void> {
  // Existing valid heads can gain initialization evidence without rebuilding
  // their encrypted state. The marker is immutable and shares the tree cap.
  const row = await lockGroup(
    tx,
    params.scope.organizationId,
    params.scope.groupId,
  );
  if (!row) throw scopeConflict();
  const gate = await settleGroup(
    tx,
    row,
    sessionFrom(params.scope),
    params.now,
  );
  if (gate.status !== "live") throw scopeConflict();
  const key = headMarkerKey(params.wire);
  const existing = await readPairs(tx, gate, [key]);
  if (existing.has(key)) return;
  await writePairs(
    tx,
    gate,
    [
      preparePair({
        fragmentKey: key,
        original: params.state,
        rewritten: params.state,
      }),
    ],
    existing,
  );
}

async function deletePayload(
  tx: RewriteTx,
  params: {
    organizationId: string;
    groupId: string;
    table: "openappa_rewrite_pairs" | "openappa_rewrite_heads";
    limit: number;
  },
): Promise<number> {
  if (params.limit <= 0) return 0;
  const result =
    params.table === "openappa_rewrite_pairs"
      ? await tx.execute(sql`
          WITH doomed AS (
            SELECT ctid
            FROM openappa_rewrite_pairs
            WHERE organization_id = ${params.organizationId}
              AND group_id = ${params.groupId}
            LIMIT ${params.limit}
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM openappa_rewrite_pairs
          WHERE ctid IN (SELECT ctid FROM doomed)
          RETURNING 1 AS deleted
        `)
      : await tx.execute(sql`
          WITH doomed AS (
            SELECT ctid
            FROM openappa_rewrite_heads
            WHERE organization_id = ${params.organizationId}
              AND group_id = ${params.groupId}
            LIMIT ${params.limit}
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM openappa_rewrite_heads
          WHERE ctid IN (SELECT ctid FROM doomed)
          RETURNING 1 AS deleted
        `);
  return result.rows.length;
}

async function markSweptIfEmpty(
  tx: RewriteTx,
  group: { organizationId: string; groupId: string },
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE openappa_rewrite_groups g
    SET payload_swept_at = ${now}
    WHERE g.organization_id = ${group.organizationId}
      AND g.group_id = ${group.groupId}
      AND g.status = 'expired'
      AND g.payload_swept_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM openappa_rewrite_pairs p
        WHERE p.organization_id = g.organization_id
          AND p.group_id = g.group_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM openappa_rewrite_heads h
        WHERE h.organization_id = g.organization_id
          AND h.group_id = g.group_id
      )
  `);
}

async function resolveNow(tx: RewriteTx, now: Date | undefined): Promise<Date> {
  if (now) return now;
  const result = await tx.execute<{ now: Date | string }>(
    sql`SELECT clock_timestamp() AS "now"`,
  );
  const value = result.rows[0]?.now;
  if (!value) throw scopeConflict();
  return asDate(value);
}

function creationLimits(params: OpenAppaRewriteOpenInput): {
  idleTtlMs: number;
  maxEntries: number;
  maxBytes: number;
} {
  assertProtocol(params.protocolVersion);
  assertIdentity(params.organizationId, params.sessionId);
  assertNow(params.now);
  const idleTtlMs = params.idleTtlMs ?? OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS;
  const maxEntries = params.maxEntries ?? OPENAPPA_REWRITE_DEFAULT_MAX_ENTRIES;
  const maxBytes = params.maxBytes ?? OPENAPPA_REWRITE_DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(idleTtlMs) ||
    idleTtlMs < 1 ||
    idleTtlMs > OPENAPPA_REWRITE_MAX_IDLE_TTL_MS ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > OPENAPPA_REWRITE_MAX_ENTRIES ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > OPENAPPA_REWRITE_MAX_BYTES
  ) {
    throw limitError();
  }
  return { idleTtlMs, maxEntries, maxBytes };
}

function prepareBatch(batch: readonly OpenAppaRewritePair[]): PreparedPair[] {
  const prepared = batch.map(preparePair);
  const seen = new Set<string>();
  for (const pair of prepared) {
    if (seen.has(pair.fragmentKey)) throw recordConflict();
    seen.add(pair.fragmentKey);
  }
  return prepared;
}

function preparePair(pair: OpenAppaRewritePair): PreparedPair {
  assertKey(pair.fragmentKey);
  const original = asBytes(pair.original, OPENAPPA_REWRITE_MAX_PAIR_BYTES);
  const rewritten = asBytes(pair.rewritten, OPENAPPA_REWRITE_MAX_PAIR_BYTES);
  return {
    fragmentKey: pair.fragmentKey,
    original,
    rewritten,
    originalDigest: digestOf(original),
    rewrittenDigest: digestOf(rewritten),
    byteLen: original.length + rewritten.length,
  };
}

function uniqueKeys(keys: readonly string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    assertKey(key);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

function textArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  let out = "{";
  for (let i = 0; i < values.length; i++) {
    if (i > 0) out += ",";
    out += '"';
    const value = values[i] ?? "";
    for (let c = 0; c < value.length; c++) {
      const ch = value[c];
      if (ch === "\\" || ch === '"') out += "\\";
      out += ch;
    }
    out += '"';
  }
  out += "}";
  return out;
}

function leaseHealthy(expiresAt: Date, now: Date, idleTtlMs: number): boolean {
  const remaining = expiresAt.getTime() - now.getTime();
  return remaining >= idleTtlMs && remaining >= OPENAPPA_REWRITE_TOUCH_SLACK_MS;
}

function assertProtocol(protocolVersion: number): void {
  if (protocolVersion !== OPENAPPA_REWRITE_PROTOCOL_VERSION) {
    throw scopeConflict();
  }
}

function assertIdentity(organizationId: string, sessionId: string): void {
  if (!nonEmpty(organizationId) || !nonEmpty(sessionId)) throw scopeConflict();
}

function assertScope(scope: OpenAppaRewriteScope): void {
  if (
    !nonEmpty(scope.organizationId) ||
    !nonEmpty(scope.sessionId) ||
    !nonEmpty(scope.root) ||
    !nonEmpty(scope.groupId) ||
    !Number.isSafeInteger(scope.epoch) ||
    scope.epoch < 1 ||
    scope.protocolVersion !== OPENAPPA_REWRITE_PROTOCOL_VERSION ||
    !(scope.expiresAt instanceof Date) ||
    Number.isNaN(scope.expiresAt.getTime())
  ) {
    throw scopeConflict();
  }
}

function assertKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > OPENAPPA_REWRITE_MAX_KEY_LENGTH ||
    key.includes("\0")
  ) {
    throw limitError();
  }
}

function assertWire(wire: string): void {
  if (
    typeof wire !== "string" ||
    wire.length === 0 ||
    wire.length > OPENAPPA_REWRITE_MAX_WIRE_LENGTH ||
    wire.includes("\0")
  ) {
    throw limitError();
  }
}

function assertRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw limitError();
  }
}

function assertNow(now: Date | undefined): void {
  if (now === undefined) return;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw limitError();
}

function sweepBatch(batchSize: number | undefined): number {
  if (batchSize === undefined) return OPENAPPA_REWRITE_DEFAULT_SWEEP_BATCH;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > OPENAPPA_REWRITE_MAX_SWEEP_BATCH
  ) {
    throw limitError();
  }
  return batchSize;
}

function asBytes(value: Buffer | Uint8Array, max: number): Buffer {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw limitError();
  }
  const bytes = Buffer.from(value);
  if (bytes.length > max) throw limitError();
  return bytes;
}

function verifiedBytes(value: Buffer, digestHex: string): Buffer {
  const bytes = normalizeByteaField({ value }, "value").value;
  if (digestOf(bytes) !== digestHex) throw recordConflict();
  return bytes;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function headMarkerKey(wire: string): string {
  return `head-initialized:v1:${wire}`;
}

function leaseEnd(now: Date, idleTtlMs: number): Date {
  return new Date(now.getTime() + idleTtlMs + OPENAPPA_REWRITE_TOUCH_SLACK_MS);
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw scopeConflict();
  return date;
}

function nonEmpty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function expiredError(): ApiError {
  return fail(410, EXPIRED_MESSAGE);
}

function scopeConflict(): ApiError {
  return fail(409, SCOPE_CONFLICT_MESSAGE);
}

function recordConflict(): ApiError {
  return fail(409, RECORD_CONFLICT_MESSAGE);
}

function limitError(): ApiError {
  return fail(400, LIMIT_MESSAGE);
}

function fail(statusCode: 400 | 409 | 410, message: string): ApiError {
  const error = new ApiError(statusCode, message);
  error.shouldRetry = false;
  return error;
}

type EnrollmentRow = {
  sessionId: string;
  root: string;
  mappedGroupId: string | null;
  groupId: string | null;
  epoch: number | string | null;
  protocolVersion: number | string | null;
  status: string | null;
  idleTtlMs: number | string | null;
  expiresAt: Date | string | null;
  now: Date | string;
};

type ScopeRow = {
  sessionId: string;
  root: string;
  epoch: number | string | null;
  protocolVersion: number | string | null;
  status: string | null;
  idleTtlMs: number | string | null;
  expiresAt: Date | string | null;
  entryCount: number | string | null;
  byteCount: number | string | null;
  maxEntries: number | string | null;
  maxBytes: number | string | null;
  now: Date | string;
  fragmentKey: string | null;
  original: Buffer | null;
  originalDigest: string | null;
  rewritten: Buffer | null;
  rewrittenDigest: string | null;
  byteLen: number | string | null;
  reservationExpiresAt: Date | string | null;
  wire: string | null;
  revision: number | string | null;
  state: Buffer | null;
  stateDigest: string | null;
  headInitialized: boolean;
};

type SweepRow = {
  organizationId: string;
  groupId: string;
  epoch: number | string;
  protocolVersion: number | string;
  status: string;
  idleTtlMs: number | string;
  expiresAt: Date | string;
  entryCount: number | string;
  byteCount: number | string;
  maxEntries: number | string;
  maxBytes: number | string;
  payloadSweptAt: Date | string | null;
  now: Date | string;
};
