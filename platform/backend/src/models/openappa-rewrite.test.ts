import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import db, { schema } from "@/database";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";
import { openappaActor } from "@/openappa/actor";
import { ApiError } from "@/types";
import {
  OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS,
  OPENAPPA_REWRITE_MAX_BATCH,
  OPENAPPA_REWRITE_MAX_BYTES,
  OPENAPPA_REWRITE_MAX_ENTRIES,
  OPENAPPA_REWRITE_MAX_FORK_DEPTH,
  OPENAPPA_REWRITE_MAX_IDLE_TTL_MS,
  OPENAPPA_REWRITE_MAX_SWEEP_BATCH,
  OPENAPPA_REWRITE_TOUCH_SLACK_MS,
  type OpenAppaRewritePair,
  type OpenAppaRewriteScope,
} from "@/types/openappa-rewrite";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

async function native(params: {
  organizationId: string;
  sessionId: string;
  root: string;
  parentId?: string | null;
  forkedFrom?: string | null;
}) {
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(params.sessionId),
    root: params.root,
    organizationId: params.organizationId,
    callerId: "caller",
    sessionId: params.sessionId,
    parentId: params.parentId ?? null,
    forkedFrom: params.forkedFrom ?? null,
    startDecision: { decision: "ack" },
  });
}

function bytes(
  key: string,
  original: Buffer | string,
  rewritten: Buffer | string,
): OpenAppaRewritePair {
  return {
    fragmentKey: key,
    original: Buffer.isBuffer(original) ? original : Buffer.from(original),
    rewritten: Buffer.isBuffer(rewritten) ? rewritten : Buffer.from(rewritten),
  };
}

async function openAt(params: {
  organizationId: string;
  sessionId: string;
  root: string;
  now?: Date;
  idleTtlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  parentId?: string | null;
  forkedFrom?: string | null;
}) {
  await native(params);
  return OpenAppaRewriteModel.open({
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    protocolVersion: 1,
    idleTtlMs: params.idleTtlMs ?? 60_000,
    maxEntries: params.maxEntries,
    maxBytes: params.maxBytes,
    now: params.now ?? T0,
  });
}

function same(left: Buffer, right: Buffer) {
  expect(Buffer.compare(left, right)).toBe(0);
}

async function pairCount(scope: OpenAppaRewriteScope) {
  const rows = await db
    .select({ key: schema.openappaRewritePairsTable.fragmentKey })
    .from(schema.openappaRewritePairsTable)
    .where(
      eq(schema.openappaRewritePairsTable.organizationId, scope.organizationId),
    );
  return rows.length;
}

describe("OpenAppaRewriteModel", () => {
  test("returns byte-identical awkward JSON, Unicode, and binary", async () => {
    const scope = await openAt({
      organizationId: "org-bytes",
      sessionId: "session",
      root: "root-bytes",
    });
    const original = Buffer.from(
      '{"text":"caf\u00e9 \\\\u0000 \\\\uD800 \\"quotes\\" / slash","emoji":"\u{1F44B}","dup":1,"dup":2}',
      "utf8",
    );
    const rewritten = Buffer.concat([
      Buffer.from('{"kept":"caf\u00e9 \\u0041"}', "utf8"),
      Buffer.from([0x00, 0xff, 0xfe, 0x80]),
    ]);
    const key = 'family:direction:caf\u00e9/"quote"';
    const stored = await OpenAppaRewriteModel.appendBatch(
      scope,
      [bytes(key, original, rewritten)],
      { now: T0 },
    );
    const loaded = await OpenAppaRewriteModel.loadBatch(scope, [key], {
      now: T0,
    });
    same(stored[0].original, original);
    same(stored[0].rewritten, rewritten);
    same(loaded[0].original, original);
    same(loaded[0].rewritten, rewritten);
    const nfd = "family:direction:cafe\u0301";
    expect(
      await OpenAppaRewriteModel.loadBatch(scope, [nfd], { now: T0 }),
    ).toEqual([]);
  });

  test("keeps the first writer's bytes and accepts an identical retry", async () => {
    const scope = await openAt({
      organizationId: "org-immutable",
      sessionId: "session",
      root: "root-immutable",
      maxEntries: 1,
    });
    const first = bytes("k", "original", "rewritten");
    await OpenAppaRewriteModel.appendBatch(scope, [first], { now: T0 });
    const again = await OpenAppaRewriteModel.appendBatch(scope, [first], {
      now: T0,
    });
    same(again[0].original, first.original);
    same(again[0].rewritten, first.rewritten);
    expect(await pairCount(scope)).toBe(1);
    await expect(
      OpenAppaRewriteModel.appendBatch(
        scope,
        [bytes("k", "original", "other")],
        { now: T0 },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
      shouldRetry: false,
    });
    const loaded = await OpenAppaRewriteModel.loadBatch(scope, ["k"], {
      now: T0,
    });
    same(loaded[0].rewritten, first.rewritten);
    await expect(
      OpenAppaRewriteModel.appendBatch(scope, [bytes("other", "a", "b")], {
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await pairCount(scope)).toBe(1);
  });

  test("hides pairs from another tenant, session, or forged scope", async () => {
    const owner = await openAt({
      organizationId: "org-a",
      sessionId: "owner",
      root: "root-a",
    });
    await OpenAppaRewriteModel.appendBatch(
      owner,
      [bytes("shared-key", "secret-payload", "rewritten")],
      { now: T0 },
    );
    const otherOrg = await openAt({
      organizationId: "org-b",
      sessionId: "owner",
      root: "root-a",
    });
    const otherSession = await openAt({
      organizationId: "org-a",
      sessionId: "stranger",
      root: "root-b",
    });
    expect(
      await OpenAppaRewriteModel.loadBatch(otherOrg, ["shared-key"], {
        now: T0,
      }),
    ).toEqual([]);
    expect(
      await OpenAppaRewriteModel.loadBatch(otherSession, ["shared-key"], {
        now: T0,
      }),
    ).toEqual([]);
    await expect(
      OpenAppaRewriteModel.loadBatch(
        { ...otherSession, groupId: owner.groupId },
        ["shared-key"],
        { now: T0 },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay scope conflict",
      shouldRetry: false,
    });
    const conflict = await OpenAppaRewriteModel.appendBatch(
      owner,
      [bytes("shared-key", "secret-payload", "leaked")],
      { now: T0 },
    ).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(String((conflict as Error).message)).not.toContain("secret-payload");
  });

  test("child and fork activity protect the retention group without parsing session ids", async () => {
    const ttl = 1_000;
    const parent = await openAt({
      organizationId: "org-tree",
      sessionId: "lead",
      root: "native-root",
      idleTtlMs: ttl,
    });
    await OpenAppaRewriteModel.appendBatch(parent, [bytes("p", "o", "r")], {
      now: T0,
    });
    const unprotected = later(parent.expiresAt.getTime() - T0.getTime() + 1);
    await OpenAppaRewriteModel.expireInactive({ now: unprotected });
    await expect(
      OpenAppaRewriteModel.loadBatch(parent, ["p"], { now: unprotected }),
    ).rejects.toMatchObject({ statusCode: 410 });

    const protectedParent = await openAt({
      organizationId: "org-protected",
      sessionId: "lead",
      root: "shared-root",
      idleTtlMs: ttl,
    });
    await OpenAppaRewriteModel.appendBatch(
      protectedParent,
      [bytes("p", "o", "r")],
      { now: T0 },
    );
    await native({
      organizationId: "org-protected",
      sessionId: "teammate",
      root: "shared-root",
      parentId: "lead",
    });
    const childTouch = later(OPENAPPA_REWRITE_TOUCH_SLACK_MS + 1);
    await OpenAppaRewriteModel.open({
      organizationId: "org-protected",
      sessionId: "teammate",
      protocolVersion: 1,
      idleTtlMs: ttl,
      now: childTouch,
    });
    await OpenAppaRewriteModel.expireInactive({ now: unprotected });
    const kept = await OpenAppaRewriteModel.loadBatch(protectedParent, ["p"], {
      now: childTouch,
    });
    expect(kept).toHaveLength(1);

    const source = await openAt({
      organizationId: "org-fork",
      sessionId: "source",
      root: "source-root",
      idleTtlMs: ttl,
    });
    await OpenAppaRewriteModel.appendBatch(
      source,
      [bytes("inherited", "a", "b")],
      {
        now: T0,
      },
    );
    const fork = await openAt({
      organizationId: "org-fork",
      sessionId: "fork",
      root: "fork-root",
      forkedFrom: "source",
      idleTtlMs: ttl,
      now: childTouch,
    });
    expect(fork.groupId).toBe(source.groupId);
    expect(fork.root).toBe("fork-root");
    expect(
      await OpenAppaRewriteModel.loadBatch(fork, ["inherited"], {
        now: childTouch,
      }),
    ).toEqual([]);
    const sourceAgain = await OpenAppaRewriteModel.openExisting({
      organizationId: "org-fork",
      sessionId: "source",
      protocolVersion: 1,
      now: childTouch,
    });
    const inherited = await OpenAppaRewriteModel.loadBatch(
      sourceAgain,
      ["inherited"],
      { now: childTouch },
    );
    same(inherited[0].original, Buffer.from("a"));
    await OpenAppaRewriteModel.expireInactive({ now: unprotected });
    expect(
      await OpenAppaRewriteModel.loadBatch(sourceAgain, ["inherited"], {
        now: childTouch,
      }),
    ).toHaveLength(1);
  });

  test("expiry strips payload, keeps the tombstone, and refuses reopen", async () => {
    const scope = await openAt({
      organizationId: "org-expire",
      sessionId: "session",
      root: "root-expire",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("head"),
      now: T0,
    });
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
      now: T0,
    });
    const after = new Date(scope.expiresAt.getTime() + 1);
    const deleted = await OpenAppaRewriteModel.expireInactive({
      now: after,
      batchSize: 10,
    });
    expect(deleted).toBe(3);
    expect(await pairCount(scope)).toBe(0);
    const [tombstone] = await db
      .select({
        status: schema.openappaRewriteGroupsTable.status,
        epoch: schema.openappaRewriteGroupsTable.epoch,
      })
      .from(schema.openappaRewriteGroupsTable)
      .where(
        eq(
          schema.openappaRewriteGroupsTable.organizationId,
          scope.organizationId,
        ),
      );
    expect(tombstone).toMatchObject({ status: "expired", epoch: 1 });
    await expect(
      OpenAppaRewriteModel.open({
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        protocolVersion: 1,
        now: after,
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      message: "Replay retention expired",
      shouldRetry: false,
    });
    await expect(
      OpenAppaRewriteModel.openExisting({
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        protocolVersion: 1,
        now: after,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
    const groups = await db
      .select({ status: schema.openappaRewriteGroupsTable.status })
      .from(schema.openappaRewriteGroupsTable);
    expect(groups).toEqual([{ status: "expired" }]);
  });

  test("a live append is not swept, and an expired append cannot succeed", async () => {
    const scope = await openAt({
      organizationId: "org-race",
      sessionId: "session",
      root: "root-race",
      idleTtlMs: 1_000,
    });
    const liveAt = new Date(scope.expiresAt.getTime() - 1);
    const [appended, swept] = await Promise.all([
      OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
        now: liveAt,
      }).then(
        () => "appended" as const,
        (error: unknown) => error,
      ),
      OpenAppaRewriteModel.expireInactive({ now: liveAt, batchSize: 8 }),
    ]);
    expect(appended).toBe("appended");
    expect(swept).toBe(0);
    expect(
      await OpenAppaRewriteModel.loadBatch(scope, ["k"], { now: liveAt }),
    ).toHaveLength(1);

    const renewed = await OpenAppaRewriteModel.verify(scope, { now: liveAt });
    const expiredAt = new Date(renewed.expiresAt.getTime() + 1);
    const [lateAppend, lateSweep] = await Promise.all([
      OpenAppaRewriteModel.appendBatch(scope, [bytes("late", "o", "r")], {
        now: expiredAt,
      }).then(
        () => "appended" as const,
        (error: unknown) => error,
      ),
      OpenAppaRewriteModel.expireInactive({ now: expiredAt, batchSize: 8 }),
    ]);
    expect(lateAppend).toMatchObject({ statusCode: 410 });
    expect(lateSweep).toBe(1);
    await expect(
      OpenAppaRewriteModel.verify(scope, { now: expiredAt }),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(await pairCount(scope)).toBe(0);
  });

  test("rejects oversized batches and tree limits without partial writes", async () => {
    const scope = await openAt({
      organizationId: "org-limits",
      sessionId: "session",
      root: "root-limits",
      maxEntries: 2,
      maxBytes: 8,
    });
    await expect(
      OpenAppaRewriteModel.appendBatch(
        scope,
        [bytes("a", "1", "2"), bytes("b", "3", "4"), bytes("c", "5", "6")],
        { now: T0 },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Replay record limit exceeded",
    });
    expect(await pairCount(scope)).toBe(0);
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("a", "1", "2")], {
      now: T0,
    });
    await expect(
      OpenAppaRewriteModel.appendBatch(scope, [bytes("b", "1234", "5678")], {
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await pairCount(scope)).toBe(1);
    await expect(
      OpenAppaRewriteModel.open({
        organizationId: "org-limits",
        sessionId: "missing",
        protocolVersion: 1,
        idleTtlMs: OPENAPPA_REWRITE_MAX_IDLE_TTL_MS + 1,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      OpenAppaRewriteModel.appendBatch(
        scope,
        Array.from({ length: OPENAPPA_REWRITE_MAX_BATCH + 1 }, (_, index) =>
          bytes(`k${index}`, "a", "b"),
        ),
        { now: T0 },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: T0, batchSize: 500 }),
    ).toBe(0);
    await expect(
      OpenAppaRewriteModel.expireInactive({
        batchSize: OPENAPPA_REWRITE_MAX_SWEEP_BATCH + 1,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("accepts the configured retention maxima and a 512-key lookup", async () => {
    const scope = await openAt({
      organizationId: "org-batch",
      sessionId: "session",
      root: "root-batch",
      idleTtlMs: OPENAPPA_REWRITE_MAX_IDLE_TTL_MS,
      maxEntries: OPENAPPA_REWRITE_MAX_ENTRIES,
      maxBytes: OPENAPPA_REWRITE_MAX_BYTES,
    });
    expect(scope.expiresAt.getTime() - T0.getTime()).toBe(
      OPENAPPA_REWRITE_MAX_IDLE_TTL_MS + OPENAPPA_REWRITE_TOUCH_SLACK_MS,
    );
    const batch = Array.from({ length: 512 }, (_, index) =>
      bytes(`family:item:${index}`, `o${index}`, `r${index}`),
    );
    await OpenAppaRewriteModel.appendBatch(scope, batch, { now: T0 });
    const loaded = await OpenAppaRewriteModel.loadBatch(
      scope,
      batch.map((pair) => pair.fragmentKey),
      { now: T0 },
    );
    expect(loaded).toHaveLength(512);
    same(loaded[511].rewritten, Buffer.from("r511"));
  });

  test("openExisting does not create a group and reads the source scope", async () => {
    await native({
      organizationId: "org-existing",
      sessionId: "source",
      root: "source-root",
    });
    await expect(
      OpenAppaRewriteModel.openExisting({
        organizationId: "org-existing",
        sessionId: "source",
        protocolVersion: 1,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await db.select().from(schema.openappaRewriteGroupsTable),
    ).toHaveLength(0);
    await expect(
      OpenAppaRewriteModel.openExisting({
        organizationId: "org-existing",
        sessionId: "absent",
        protocolVersion: 1,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test.each([
    "live",
    "expired",
  ] as const)("does not recreate a mapped %s group whose row is missing", async (status) => {
    const scope = await openAt({
      organizationId: `org-missing-${status}`,
      sessionId: "session",
      root: "root",
    });
    await db.update(schema.openappaRewriteGroupsTable).set({ status });
    await db.delete(schema.openappaRewriteGroupsTable);
    await expect(
      OpenAppaRewriteModel.open({
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        protocolVersion: 1,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.select().from(schema.openappaRewriteGroupsTable)).toEqual(
      [],
    );
    expect(
      await db.select().from(schema.openappaRewriteRootsTable),
    ).toHaveLength(1);
  });

  test("rejects a missing initialized head without rebuilding or partially committing", async () => {
    const scope = await openAt({
      organizationId: "org-missing-head",
      sessionId: "session",
      root: "root",
    });
    await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("committed-policy-head"),
      pairs: [bytes("k", "original", "approved")],
      now: T0,
    });
    await db.delete(schema.openappaRewriteHeadsTable);
    await expect(
      OpenAppaRewriteModel.readHead(scope, "anthropic:messages", { now: T0 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 1,
        pairs: [],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      OpenAppaRewriteModel.compareAndSwapHead({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("rebuilt"),
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("rebuilt"),
        pairs: [bytes("new", "a", "b")],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await pairCount(scope)).toBe(2);
    expect(await db.select().from(schema.openappaRewriteHeadsTable)).toEqual(
      [],
    );
  });

  test("a projection no-op preserves legacy heads while adding counted initialization evidence", async () => {
    const scope = await openAt({
      organizationId: "org-existing-head",
      sessionId: "session",
      root: "root",
    });
    const state = Buffer.from("retained-existing-head");
    await db.insert(schema.openappaRewriteHeadsTable).values({
      organizationId: scope.organizationId,
      groupId: scope.groupId,
      sessionId: scope.sessionId,
      wire: "anthropic:messages",
      revision: 7,
      state,
      stateDigest: createHash("sha256").update(state).digest("hex"),
      updatedAt: T0,
    });
    const { head, pairs } = await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 7,
      pairs: [],
      now: T0,
    });
    expect(head).toEqual({ wire: "anthropic:messages", revision: 7, state });
    expect(pairs).toEqual([]);
    expect(await pairCount(scope)).toBe(1);
    expect(
      await countStatements(() =>
        OpenAppaRewriteModel.readHead(scope, "anthropic:messages", { now: T0 }),
      ),
    ).toBe(1);
    expect(
      await OpenAppaRewriteModel.readHead(scope, "openai:responses", {
        now: T0,
      }),
    ).toMatchObject({ revision: 0 });
    await db.delete(schema.openappaRewriteHeadsTable);
    await expect(
      OpenAppaRewriteModel.readHead(scope, "anthropic:messages", { now: T0 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("loads transitive parent and fork owners and rejects corrupt or foreign ancestry", async () => {
    const organizationId = "org-ancestors";
    await native({ organizationId, sessionId: "source", root: "source-root" });
    await native({
      organizationId,
      sessionId: "fork",
      root: "fork-root",
      forkedFrom: "source",
    });
    await native({
      organizationId,
      sessionId: "child",
      root: "fork-root",
      parentId: "fork",
    });
    await native({
      organizationId,
      sessionId: "grandchild",
      root: "fork-root",
      parentId: "child",
    });
    const params = {
      organizationId,
      sessionId: "grandchild",
      callerId: "caller",
    };
    expect(await OpenAppaRewriteModel.ancestorSessionIds(params)).toEqual([
      "source",
      "fork",
      "child",
    ]);
    await expect(
      OpenAppaRewriteModel.ancestorSessionIds({
        ...params,
        callerId: "foreign",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await db
      .update(schema.openappaSessionsTable)
      .set({ parentId: "grandchild" })
      .where(eq(schema.openappaSessionsTable.sessionId, "source"));
    await expect(
      OpenAppaRewriteModel.ancestorSessionIds(params),
    ).rejects.toMatchObject({ statusCode: 409 });
    await db
      .update(schema.openappaSessionsTable)
      .set({ parentId: "missing" })
      .where(eq(schema.openappaSessionsTable.sessionId, "source"));
    await expect(
      OpenAppaRewriteModel.ancestorSessionIds(params),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("refuses truncated ancestor discovery instead of loading a partial lineage", async () => {
    for (let index = 0; index < 33; index++) {
      await native({
        organizationId: "org-deep-ancestors",
        sessionId: `s${index}`,
        root: "root",
        parentId: index === 0 ? null : `s${index - 1}`,
      });
    }
    await expect(
      OpenAppaRewriteModel.ancestorSessionIds({
        organizationId: "org-deep-ancestors",
        sessionId: "s32",
        callerId: "caller",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("counts initialization evidence within the tree cap and rolls back together", async () => {
    const scope = await openAt({
      organizationId: "org-head-budget",
      sessionId: "session",
      root: "root",
      maxEntries: 1,
    });
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("head"),
        pairs: [bytes("k", "a", "b")],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await pairCount(scope)).toBe(0);
    expect(
      await OpenAppaRewriteModel.readHead(scope, "anthropic:messages", {
        now: T0,
      }),
    ).toMatchObject({ revision: 0 });
  });

  test("reserves capacity and identity before effects and finalizes immutably", async () => {
    const scope = await openAt({
      organizationId: "org-reservation",
      sessionId: "session",
      root: "root",
      maxEntries: 2,
      maxBytes: 100,
    });
    const reservedPair = bytes("receipt", "identity", "reserved");
    const reservation = await OpenAppaRewriteModel.reservePair({
      scope,
      pair: reservedPair,
      reservationId: "00000000-0000-4000-8000-000000000001",
      maxBytes: 100,
      now: T0,
    });
    expect(
      await OpenAppaRewriteModel.loadBatch(scope, ["receipt"], { now: T0 }),
    ).toEqual([]);
    await expect(
      OpenAppaRewriteModel.appendBatch(scope, [bytes("other", "a", "b")], {
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      OpenAppaRewriteModel.reservePair({
        scope,
        pair: reservedPair,
        reservationId: "00000000-0000-4000-8000-000000000002",
        maxBytes: 100,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const final = bytes("receipt", "exact-result", "applied");
    await expect(
      OpenAppaRewriteModel.completeReservation({
        reservation: {
          ...reservation,
          reservationId: "00000000-0000-4000-8000-000000000002",
        },
        reservedPair,
        pair: final,
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const params = { reservation, reservedPair, pair: final, now: T0 };
    await OpenAppaRewriteModel.completeReservation(params);
    await OpenAppaRewriteModel.completeReservation(params);
    expect(
      await OpenAppaRewriteModel.loadBatch(scope, ["receipt"], { now: T0 }),
    ).toEqual([final]);
    await expect(
      OpenAppaRewriteModel.completeReservation({
        ...params,
        pair: bytes("receipt", "changed", "applied"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("other", "a", "b")], {
      now: T0,
    });
    const [group] = await db.select().from(schema.openappaRewriteGroupsTable);
    expect(group.entryCount).toBe(2);
    expect(group.byteCount).toBe(
      final.original.length + final.rewritten.length + 2,
    );
  });

  test("a live reservation blocks cleanup but an abandoned slot cannot revive expiry", async () => {
    const scope = await openAt({
      organizationId: "org-reservation-expiry",
      sessionId: "session",
      root: "root",
      idleTtlMs: 1_000,
    });
    const reservedPair = bytes("receipt", "identity", "reserved");
    const reservation = await OpenAppaRewriteModel.reservePair({
      scope,
      pair: reservedPair,
      reservationId: "00000000-0000-4000-8000-000000000003",
      maxBytes: 100,
      now: T0,
    });
    await db.update(schema.openappaRewriteGroupsTable).set({ expiresAt: T0 });
    expect(await OpenAppaRewriteModel.expireInactive({ now: later(500) })).toBe(
      0,
    );
    expect(await pairCount(scope)).toBe(1);
    const [group] = await db.select().from(schema.openappaRewriteGroupsTable);
    const after = new Date(group.expiresAt.getTime() + 1);
    expect(await OpenAppaRewriteModel.expireInactive({ now: after })).toBe(1);
    await expect(
      OpenAppaRewriteModel.completeReservation({
        reservation,
        reservedPair,
        pair: bytes("receipt", "late-result", "applied"),
        now: after,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(await pairCount(scope)).toBe(0);
  });

  test("concurrent reservation and append cannot overbook the shared cap", async () => {
    const scope = await openAt({
      organizationId: "org-reservation-race",
      sessionId: "session",
      root: "root",
      maxEntries: 1,
      maxBytes: 100,
    });
    const results = await Promise.allSettled([
      OpenAppaRewriteModel.reservePair({
        scope,
        pair: bytes("reserved", "identity", "reserved"),
        reservationId: "00000000-0000-4000-8000-000000000004",
        maxBytes: 100,
        now: T0,
      }),
      OpenAppaRewriteModel.appendBatch(scope, [bytes("ordinary", "a", "b")], {
        now: T0,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await pairCount(scope)).toBe(1);
    const [group] = await db.select().from(schema.openappaRewriteGroupsTable);
    expect(group.entryCount).toBe(1);
    expect(group.byteCount).toBeLessThanOrEqual(100);
  });

  test("pending native work on a fork root blocks collection", async () => {
    const source = await openAt({
      organizationId: "org-pending",
      sessionId: "source",
      root: "source-root",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.appendBatch(source, [bytes("k", "o", "r")], {
      now: T0,
    });
    await native({
      organizationId: "org-pending",
      sessionId: "fork",
      root: "fork-root",
      forkedFrom: "source",
    });
    const after = new Date(source.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: "org-pending",
      sessionId: "fork",
      operationId: "op-1",
      root: "fork-root",
      status: "pending",
      input: { call: "x" },
      createdAt: new Date(after.getTime() - 100),
    });
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 8 }),
    ).toBe(0);
    const renewed = await OpenAppaRewriteModel.verify(source, { now: after });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(after.getTime());
    await db
      .delete(schema.openappaOperationsTable)
      .where(eq(schema.openappaOperationsTable.operationId, "op-1"));
    const clearedAt = new Date(renewed.expiresAt.getTime() + 1);
    expect(
      await OpenAppaRewriteModel.expireInactive({
        now: clearedAt,
        batchSize: 8,
      }),
    ).toBe(1);
    expect(await pairCount(source)).toBe(0);
  });

  test("an abandoned pending operation does not retain the group", async () => {
    const scope = await openAt({
      organizationId: "org-abandoned",
      sessionId: "session",
      root: "root-abandoned",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
      now: T0,
    });
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: "org-abandoned",
      sessionId: "session",
      operationId: "stuck",
      root: "root-abandoned",
      status: "pending",
      input: { call: "x" },
      createdAt: T0,
    });
    const after = new Date(scope.expiresAt.getTime() + 1);
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 4 }),
    ).toBe(1);
    await expect(
      OpenAppaRewriteModel.open({
        organizationId: "org-abandoned",
        sessionId: "session",
        protocolVersion: 1,
        now: after,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test("seeds mapped fork chains once and still protects unmapped descendants", async () => {
    const source = await openAt({
      organizationId: "org-fork-seeds",
      sessionId: "mapped-0",
      root: "mapped-root-0",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.appendBatch(source, [bytes("k", "o", "r")], {
      now: T0,
    });
    for (let index = 1; index <= 2; index++) {
      const fork = await openAt({
        organizationId: source.organizationId,
        sessionId: `mapped-${index}`,
        root: `mapped-root-${index}`,
        forkedFrom: `mapped-${index - 1}`,
        now: T0,
      });
      expect(fork.groupId).toBe(source.groupId);
    }
    for (let index = 1; index <= 2; index++) {
      await native({
        organizationId: source.organizationId,
        sessionId: `unmapped-${index}`,
        root: `unmapped-root-${index}`,
        forkedFrom: index === 1 ? "mapped-2" : "unmapped-1",
      });
    }
    const after = new Date(source.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: source.organizationId,
      sessionId: "unmapped-2",
      operationId: "pending-descendant",
      root: "unmapped-root-2",
      status: "pending",
      input: { call: "x" },
      createdAt: after,
    });
    const memberQueries: unknown[][] = [];
    await countStatements(
      async () => {
        expect(
          await OpenAppaRewriteModel.expireInactive({
            now: after,
            batchSize: 8,
          }),
        ).toBe(0);
      },
      (args) => {
        if (String(args[0]).includes("WITH RECURSIVE members AS"))
          memberQueries.push(args);
      },
    );
    const memberQuery = memberQueries[0];
    expect(memberQuery).toBeDefined();
    if (!memberQuery || typeof memberQuery[0] !== "string")
      throw new Error("Missing native-work query");
    const boundary = memberQuery[0].indexOf("SELECT 1 AS pending");
    expect(boundary).toBeGreaterThan(0);
    // Execute the production CTE with a fully consumed row set: EXISTS can stop
    // early and hide duplicate traversal of already-enrolled fork chains.
    const cte = memberQuery[0].slice(0, boundary);
    const parameterCount = Math.max(
      ...Array.from(cte.matchAll(/\$(\d+)/g), (match) => Number(match[1])),
    );
    const parameters = memberQuery[1];
    if (!Array.isArray(parameters)) throw new Error("Missing query parameters");
    const client = (
      db as unknown as {
        $client: {
          query: (
            query: string,
            params: unknown[],
          ) => Promise<{ rows: { session_id: string; depth: number }[] }>;
        };
      }
    ).$client;
    const members = await client.query(
      `${cte} SELECT session_id, depth FROM members ORDER BY session_id`,
      parameters.slice(0, parameterCount),
    );
    expect(members.rows).toEqual([
      { session_id: "mapped-0", depth: 1 },
      { session_id: "mapped-1", depth: 1 },
      { session_id: "mapped-2", depth: 1 },
      { session_id: "unmapped-1", depth: 2 },
      { session_id: "unmapped-2", depth: 3 },
    ]);
    expect(
      await OpenAppaRewriteModel.loadBatch(source, ["k"], { now: after }),
    ).toHaveLength(1);
    const renewed = await OpenAppaRewriteModel.verify(source, { now: after });
    await db.delete(schema.openappaOperationsTable);
    expect(
      await OpenAppaRewriteModel.expireInactive({
        now: new Date(renewed.expiresAt.getTime() + 1),
        batchSize: 8,
      }),
    ).toBe(1);
  });

  test("a pending processed result also blocks collection", async () => {
    const scope = await openAt({
      organizationId: "org-result",
      sessionId: "session",
      root: "root-result",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
      now: T0,
    });
    const after = new Date(scope.expiresAt.getTime() + 1);
    await db.insert(schema.openappaProcessedResultsTable).values({
      organizationId: "org-result",
      sessionId: "session",
      toolCallId: "call-1",
      root: "root-result",
      status: "pending",
      createdAt: new Date(after.getTime() - 100),
    });
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 4 }),
    ).toBe(0);
    expect(await pairCount(scope)).toBe(1);
  });

  test("touches the group at most once per slack window", async () => {
    const ttl = 60_000;
    const scope = await openAt({
      organizationId: "org-touch",
      sessionId: "session",
      root: "root-touch",
      idleTtlMs: ttl,
    });
    const early = await OpenAppaRewriteModel.verify(scope, {
      now: later(30_000),
    });
    expect(early.expiresAt.getTime()).toBe(scope.expiresAt.getTime());
    const extended = await OpenAppaRewriteModel.verify(scope, {
      now: later(OPENAPPA_REWRITE_TOUCH_SLACK_MS + 1),
    });
    expect(extended.expiresAt.getTime()).toBe(
      T0.getTime() +
        OPENAPPA_REWRITE_TOUCH_SLACK_MS +
        1 +
        ttl +
        OPENAPPA_REWRITE_TOUCH_SLACK_MS,
    );
  });

  test("head revisions are per session and wire, and corrupt bytes are refused", async () => {
    const scope = await openAt({
      organizationId: "org-head",
      sessionId: "session",
      root: "root-head",
    });
    expect(
      await OpenAppaRewriteModel.readHead(scope, "anthropic:messages", {
        now: T0,
      }),
    ).toMatchObject({ revision: 0 });
    const first = await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("chain-a"),
      now: T0,
    });
    expect(first.revision).toBe(1);
    await expect(
      OpenAppaRewriteModel.compareAndSwapHead({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("chain-b"),
        now: T0,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
    });
    const second = await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 1,
      state: Buffer.from("chain-b"),
      now: T0,
    });
    expect(second.revision).toBe(2);
    same(second.state, Buffer.from("chain-b"));
    const otherWire = await OpenAppaRewriteModel.readHead(
      scope,
      "openai:responses",
      { now: T0 },
    );
    expect(otherWire.revision).toBe(0);
    const fork = await openAt({
      organizationId: "org-head",
      sessionId: "fork",
      root: "fork-root",
      forkedFrom: "session",
    });
    expect(
      (
        await OpenAppaRewriteModel.readHead(fork, "anthropic:messages", {
          now: T0,
        })
      ).revision,
    ).toBe(0);
    await db
      .update(schema.openappaRewritePairsTable)
      .set({ originalDigest: "0".repeat(64) })
      .where(
        eq(
          schema.openappaRewritePairsTable.organizationId,
          scope.organizationId,
        ),
      );
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
      now: T0,
    });
    await db
      .update(schema.openappaRewritePairsTable)
      .set({ originalDigest: "f".repeat(64) })
      .where(eq(schema.openappaRewritePairsTable.fragmentKey, "k"));
    await expect(
      OpenAppaRewriteModel.loadBatch(scope, ["k"], { now: T0 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
    });
  });

  test("does not write native session rows and uses a 24h default lease", async () => {
    await native({
      organizationId: "org-native",
      sessionId: "session",
      root: "root-native",
    });
    const before = await db
      .select()
      .from(schema.openappaSessionsTable)
      .where(eq(schema.openappaSessionsTable.organizationId, "org-native"));
    const beforeMs = Date.now();
    const scope = await OpenAppaRewriteModel.open({
      organizationId: "org-native",
      sessionId: "session",
      protocolVersion: 1,
    });
    const afterMs = Date.now();
    const after = await db
      .select()
      .from(schema.openappaSessionsTable)
      .where(eq(schema.openappaSessionsTable.organizationId, "org-native"));
    expect(after).toEqual(before);
    expect(scope.expiresAt.getTime()).toBeGreaterThanOrEqual(
      beforeMs +
        OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS +
        OPENAPPA_REWRITE_TOUCH_SLACK_MS -
        10_000,
    );
    expect(scope.expiresAt.getTime()).toBeLessThanOrEqual(
      afterMs +
        OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS +
        OPENAPPA_REWRITE_TOUCH_SLACK_MS +
        10_000,
    );
  });

  test("sweeps one expired tree without deleting another", async () => {
    const idle = await openAt({
      organizationId: "org-sweep",
      sessionId: "idle",
      root: "idle-root",
      idleTtlMs: 1_000,
    });
    const live = await openAt({
      organizationId: "org-sweep",
      sessionId: "live",
      root: "live-root",
      idleTtlMs: 60_000,
    });
    await OpenAppaRewriteModel.appendBatch(idle, [bytes("gone", "o", "r")], {
      now: T0,
    });
    await OpenAppaRewriteModel.appendBatch(live, [bytes("stay", "o", "r")], {
      now: T0,
    });
    const otherOrg = await openAt({
      organizationId: "org-sweep-other",
      sessionId: "idle",
      root: idle.root,
      idleTtlMs: 60_000,
    });
    await OpenAppaRewriteModel.appendBatch(
      otherOrg,
      [bytes("stay", "o", "r")],
      {
        now: T0,
      },
    );
    for (const scope of [idle, live, otherOrg]) {
      await OpenAppaRewriteModel.compareAndSwapHead({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("head"),
        now: T0,
      });
    }
    const sweep = {
      now: new Date(idle.expiresAt.getTime() + 1),
      batchSize: 2,
    };
    expect(await OpenAppaRewriteModel.expireInactive(sweep)).toBe(2);
    expect(await OpenAppaRewriteModel.expireInactive(sweep)).toBe(1);
    expect(await pairCount(live)).toBe(2);
    for (const scope of [live, otherOrg]) {
      expect(
        await OpenAppaRewriteModel.readHead(scope, "anthropic:messages", {
          now: T0,
        }),
      ).toMatchObject({ revision: 1, state: Buffer.from("head") });
    }
    expect(
      await OpenAppaRewriteModel.loadBatch(otherOrg, ["stay"], { now: T0 }),
    ).toHaveLength(1);
    expect(
      await OpenAppaRewriteModel.loadBatch(live, ["stay"], { now: T0 }),
    ).toHaveLength(1);
    await expect(
      OpenAppaRewriteModel.open({
        organizationId: "org-sweep",
        sessionId: "idle",
        protocolVersion: 1,
        now: new Date(idle.expiresAt.getTime() + 1),
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test("a partial sweep stays expired when later pending work appears", async () => {
    const scope = await openAt({
      organizationId: "org-terminal",
      sessionId: "session",
      root: "root-terminal",
      idleTtlMs: 1_000,
    });
    const batchSize = 2;
    await OpenAppaRewriteModel.appendBatch(
      scope,
      [
        bytes("p1", "o1", "r1"),
        bytes("p2", "o2", "r2"),
        bytes("p3", "o3", "r3"),
      ],
      { now: T0 },
    );
    await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("head-a"),
      now: T0,
    });
    await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "openai:responses",
      expectedRevision: 0,
      state: Buffer.from("head-b"),
      now: T0,
    });
    const after = new Date(scope.expiresAt.getTime() + 1);
    const deleted = await OpenAppaRewriteModel.expireInactive({
      now: after,
      batchSize,
    });
    expect(deleted).toBe(batchSize);
    const [group] = await db
      .select({
        status: schema.openappaRewriteGroupsTable.status,
        payloadSweptAt: schema.openappaRewriteGroupsTable.payloadSweptAt,
      })
      .from(schema.openappaRewriteGroupsTable)
      .where(
        eq(
          schema.openappaRewriteGroupsTable.organizationId,
          scope.organizationId,
        ),
      );
    expect(group).toMatchObject({ status: "expired", payloadSweptAt: null });
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: scope.organizationId,
      sessionId: scope.sessionId,
      operationId: "late",
      root: scope.root,
      status: "pending",
      input: { call: "x" },
      createdAt: after,
    });
    const refused = { statusCode: 410, message: "Replay retention expired" };
    await expect(
      OpenAppaRewriteModel.openExisting({
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        protocolVersion: 1,
        now: after,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      OpenAppaRewriteModel.loadBatch(scope, ["p1", "p2", "p3"], { now: after }),
    ).rejects.toMatchObject(refused);
    await expect(
      OpenAppaRewriteModel.appendBatch(scope, [bytes("p3", "o3", "r3")], {
        now: after,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      OpenAppaRewriteModel.readHead(scope, "anthropic:messages", {
        now: after,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      OpenAppaRewriteModel.compareAndSwapHead({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("rebuilt"),
        now: after,
      }),
    ).rejects.toMatchObject(refused);
    const beforeFinish = await db
      .select({ key: schema.openappaRewritePairsTable.fragmentKey })
      .from(schema.openappaRewritePairsTable);
    const headsBeforeFinish = await db
      .select({
        revision: schema.openappaRewriteHeadsTable.revision,
        state: schema.openappaRewriteHeadsTable.state,
      })
      .from(schema.openappaRewriteHeadsTable);
    expect(headsBeforeFinish.every((row) => row.revision >= 1)).toBe(true);
    expect(
      headsBeforeFinish.some((row) =>
        Buffer.from(row.state).equals(Buffer.from("rebuilt")),
      ),
    ).toBe(false);
    await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 8 });
    const pairs = await db
      .select({ key: schema.openappaRewritePairsTable.fragmentKey })
      .from(schema.openappaRewritePairsTable);
    const heads = await db
      .select({
        wire: schema.openappaRewriteHeadsTable.wire,
        revision: schema.openappaRewriteHeadsTable.revision,
      })
      .from(schema.openappaRewriteHeadsTable);
    expect(pairs).toEqual([]);
    expect(heads).toEqual([]);
    expect(beforeFinish.length).toBeGreaterThan(0);
    expect(beforeFinish.map((row) => row.key)).not.toContain("rebuilt");
  });

  test("pending work renews a due lease instead of keeping it at the sweep head", async () => {
    const ttl = 1_000;
    const protectedGroup = await openAt({
      organizationId: "org-renew",
      sessionId: "hot",
      root: "hot-root",
      idleTtlMs: ttl,
    });
    const other = await openAt({
      organizationId: "org-renew",
      sessionId: "other",
      root: "other-root",
      idleTtlMs: ttl,
    });
    await OpenAppaRewriteModel.appendBatch(
      protectedGroup,
      [bytes("keep", "o", "r")],
      { now: T0 },
    );
    await OpenAppaRewriteModel.appendBatch(other, [bytes("drop", "o", "r")], {
      now: T0,
    });
    await db
      .update(schema.openappaRewriteGroupsTable)
      .set({
        expiresAt: new Date(protectedGroup.expiresAt.getTime() - 1),
      })
      .where(
        eq(schema.openappaRewriteGroupsTable.groupId, protectedGroup.groupId),
      );
    const after = new Date(protectedGroup.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: "org-renew",
      sessionId: "hot",
      operationId: "op",
      root: "hot-root",
      status: "pending",
      input: { call: "x" },
      createdAt: new Date(after.getTime() - 100),
    });
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 1 }),
    ).toBe(0);
    const [renewed] = await db
      .select({ expiresAt: schema.openappaRewriteGroupsTable.expiresAt })
      .from(schema.openappaRewriteGroupsTable)
      .where(
        eq(schema.openappaRewriteGroupsTable.groupId, protectedGroup.groupId),
      );
    expect(renewed?.expiresAt.getTime()).toBe(
      after.getTime() + ttl + OPENAPPA_REWRITE_TOUCH_SLACK_MS,
    );
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 1 }),
    ).toBe(1);
    expect(
      await OpenAppaRewriteModel.loadBatch(protectedGroup, ["keep"], {
        now: after,
      }),
    ).toHaveLength(1);
    await expect(
      OpenAppaRewriteModel.loadBatch(other, ["drop"], { now: after }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test("a pending row created just after the last touch still protects the lease", async () => {
    const ttl = 1_000;
    const scope = await openAt({
      organizationId: "org-lookback",
      sessionId: "session",
      root: "root-lookback",
      idleTtlMs: ttl,
    });
    await OpenAppaRewriteModel.appendBatch(scope, [bytes("k", "o", "r")], {
      now: T0,
    });
    const after = new Date(scope.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: scope.organizationId,
      sessionId: scope.sessionId,
      operationId: "just-after",
      root: scope.root,
      status: "pending",
      input: { call: "x" },
      createdAt: new Date(T0.getTime() + 1),
    });
    expect(
      await OpenAppaRewriteModel.expireInactive({ now: after, batchSize: 4 }),
    ).toBe(0);
    expect(await pairCount(scope)).toBe(1);
  });

  test("commitProjection rolls back pairs and the head together", async () => {
    const scope = await openAt({
      organizationId: "org-commit",
      sessionId: "session",
      root: "root-commit",
      maxEntries: 3,
    });
    const committed = await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("head"),
      pairs: [bytes("k", "original", "rewritten")],
      now: T0,
    });
    expect(committed.head).toMatchObject({ revision: 1 });
    same(committed.pairs[0].original, Buffer.from("original"));
    same(committed.head.state, Buffer.from("head"));
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 0,
        state: Buffer.from("other"),
        pairs: [bytes("new", "a", "b")],
        now: T0,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
    });
    expect(await pairCount(scope)).toBe(2);
    const head = await OpenAppaRewriteModel.readHead(
      scope,
      "anthropic:messages",
      {
        now: T0,
      },
    );
    expect(head.revision).toBe(1);
    same(head.state, Buffer.from("head"));
    const echoed = await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 1,
      pairs: [bytes("echo", "c", "d")],
      now: T0,
    });
    expect(echoed.head.revision).toBe(1);
    same(echoed.head.state, Buffer.from("head"));
    expect(echoed.pairs).toHaveLength(1);
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 1,
        state: Buffer.from("moved"),
        pairs: [bytes("k", "original", "different")],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const unchanged = await OpenAppaRewriteModel.readHead(
      scope,
      "anthropic:messages",
      { now: T0 },
    );
    expect(unchanged.revision).toBe(1);
    same(unchanged.state, Buffer.from("head"));
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 1,
        state: Buffer.from("over-limit"),
        pairs: [bytes("a", "1", "2"), bytes("b", "3", "4")],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await pairCount(scope)).toBe(3);
    expect(
      (
        await OpenAppaRewriteModel.readHead(scope, "anthropic:messages", {
          now: T0,
        })
      ).revision,
    ).toBe(1);
  });

  test("a healthy projection no-op reads once without advancing or touching the head", async () => {
    const scope = await openAt({
      organizationId: "org-no-op",
      sessionId: "session",
      root: "root",
    });
    const committed = await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("head"),
      pairs: [],
      now: T0,
    });
    const before = await db.select().from(schema.openappaRewriteGroupsTable);
    const statements: string[] = [];
    expect(
      await countStatements(
        async () => {
          const result = await OpenAppaRewriteModel.commitProjection({
            scope,
            wire: "anthropic:messages",
            expectedRevision: 1,
            pairs: [],
            now: later(1),
          });
          expect(result).toEqual(committed);
        },
        (args) => statements.push(String(args[0])),
      ),
    ).toBe(1);
    expect(statements[0]).not.toMatch(/FOR UPDATE|INSERT|DELETE|UPDATE/i);
    expect(await db.select().from(schema.openappaRewriteGroupsTable)).toEqual(
      before,
    );
    expect(await pairCount(scope)).toBe(1);
    for (const expectedRevision of [0, 2]) {
      await expect(
        OpenAppaRewriteModel.commitProjection({
          scope,
          wire: "anthropic:messages",
          expectedRevision,
          pairs: [],
          now: T0,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Replay record conflict",
        shouldRetry: false,
      });
    }
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "openai:responses",
        expectedRevision: 0,
        pairs: [],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    for (const forged of [
      { ...scope, epoch: scope.epoch + 1 },
      { ...scope, sessionId: "stranger" },
      { ...scope, root: "foreign-root" },
      { ...scope, organizationId: "foreign-org" },
      { ...scope, protocolVersion: 2 as unknown as 1 },
    ]) {
      await expect(
        OpenAppaRewriteModel.commitProjection({
          scope: forged,
          wire: "anthropic:messages",
          expectedRevision: 1,
          pairs: [],
          now: T0,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await db
      .update(schema.openappaRewriteHeadsTable)
      .set({ stateDigest: "0".repeat(64) });
    await expect(
      OpenAppaRewriteModel.commitProjection({
        scope,
        wire: "anthropic:messages",
        expectedRevision: 1,
        pairs: [],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("projection no-ops still renew due leases, guard pending work, and reject expiry", async () => {
    const scope = await openAt({
      organizationId: "org-no-op-expiry",
      sessionId: "session",
      root: "root",
      idleTtlMs: 1_000,
    });
    const params = {
      scope,
      wire: "anthropic:messages",
      expectedRevision: 1,
      pairs: [],
    };
    await OpenAppaRewriteModel.commitProjection({
      ...params,
      expectedRevision: 0,
      state: Buffer.from("head"),
      now: T0,
    });
    const touchAt = later(OPENAPPA_REWRITE_TOUCH_SLACK_MS + 1);
    await OpenAppaRewriteModel.commitProjection({ ...params, now: touchAt });
    const [touched] = await db.select().from(schema.openappaRewriteGroupsTable);
    expect(touched.expiresAt.getTime()).toBeGreaterThan(
      scope.expiresAt.getTime(),
    );
    const dueAt = new Date(touched.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: scope.organizationId,
      sessionId: scope.sessionId,
      operationId: "pending-no-op",
      root: scope.root,
      status: "pending",
      input: { call: "x" },
      createdAt: dueAt,
    });
    expect(
      await OpenAppaRewriteModel.commitProjection({ ...params, now: dueAt }),
    ).toMatchObject({ pairs: [], head: { revision: 1 } });
    const [renewed] = await db.select().from(schema.openappaRewriteGroupsTable);
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(dueAt.getTime());
    await db.delete(schema.openappaOperationsTable);
    const expiredAt = new Date(renewed.expiresAt.getTime() + 1);
    await expect(
      OpenAppaRewriteModel.commitProjection({ ...params, now: expiredAt }),
    ).rejects.toMatchObject({ statusCode: 410, shouldRetry: false });
    await OpenAppaRewriteModel.expireInactive({ now: expiredAt });
    await expect(
      OpenAppaRewriteModel.commitProjection({ ...params, now: expiredAt }),
    ).rejects.toMatchObject({ statusCode: 410, shouldRetry: false });
  });

  test("a healthy projection snapshot reads scope, initialized head, and requested pairs together", async () => {
    const scope = await openAt({
      organizationId: "org-projection-snapshot",
      sessionId: "owner",
      root: "root",
    });
    const wire = "anthropic:messages";
    const pair = bytes('a"b,c}d\\e', "original", "rewritten");
    await OpenAppaRewriteModel.commitProjection({
      scope,
      wire,
      expectedRevision: 0,
      state: Buffer.from("head"),
      pairs: [pair],
      now: T0,
    });
    const before = await db.select().from(schema.openappaRewriteGroupsTable);
    const statements: string[] = [];
    expect(
      await countStatements(
        async () => {
          const snapshot = await OpenAppaRewriteModel.readProjectionSnapshot({
            scope: { ...scope, expiresAt: later(1) },
            wire,
            keys: [pair.fragmentKey, pair.fragmentKey],
            now: T0,
          });
          expect(snapshot).toEqual({
            scope,
            hasAncestors: false,
            head: { wire, revision: 1, state: Buffer.from("head") },
            headInitialized: true,
            pairs: [pair],
            readOnlyNoopEligible: true,
          });
          expect(Object.isFrozen(snapshot)).toBe(true);
        },
        (args) => statements.push(String(args[0])),
      ),
    ).toBe(1);
    expect(statements[0]).not.toMatch(/FOR UPDATE|INSERT|DELETE|UPDATE/i);
    expect(await db.select().from(schema.openappaRewriteGroupsTable)).toEqual(
      before,
    );
    const incomplete = await OpenAppaRewriteModel.readProjectionSnapshot({
      scope,
      wire,
      keys: [pair.fragmentKey, "missing"],
      now: T0,
    });
    expect(incomplete.pairs).toEqual([pair]);
    expect(incomplete.readOnlyNoopEligible).toBe(false);
    const otherWire = await OpenAppaRewriteModel.readProjectionSnapshot({
      scope,
      wire: "openai:responses",
      keys: [],
      now: T0,
    });
    expect(otherWire).toMatchObject({
      head: { revision: 0 },
      headInitialized: false,
      readOnlyNoopEligible: false,
    });
  });

  test("projection snapshots reject forged scopes and corrupt heads or requested ciphertext", async () => {
    const scope = await openAt({
      organizationId: "org-snapshot-forgery",
      sessionId: "owner",
      root: "root",
    });
    const params = { scope, wire: "anthropic:messages", keys: ["k"], now: T0 };
    await OpenAppaRewriteModel.commitProjection({
      scope,
      wire: params.wire,
      expectedRevision: 0,
      state: Buffer.from("head"),
      pairs: [bytes("k", "cipher-original", "cipher-rewritten")],
      now: T0,
    });
    for (const forged of [
      { ...scope, organizationId: "foreign" },
      { ...scope, sessionId: "foreign" },
      { ...scope, root: "foreign" },
      { ...scope, groupId: "foreign" },
      { ...scope, epoch: 2 },
      { ...scope, protocolVersion: 2 as unknown as 1 },
    ]) {
      await expect(
        OpenAppaRewriteModel.readProjectionSnapshot({
          ...params,
          scope: forged,
        }),
      ).rejects.toMatchObject({ statusCode: 409, shouldRetry: false });
    }
    await db
      .update(schema.openappaRewritePairsTable)
      .set({ rewrittenDigest: "0".repeat(64) })
      .where(eq(schema.openappaRewritePairsTable.fragmentKey, "k"));
    await expect(
      OpenAppaRewriteModel.readProjectionSnapshot(params),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
    });
    await db
      .update(schema.openappaRewriteHeadsTable)
      .set({ stateDigest: "0".repeat(64) });
    await expect(
      OpenAppaRewriteModel.readProjectionSnapshot({ ...params, keys: [] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await db.delete(schema.openappaRewriteHeadsTable);
    await expect(
      OpenAppaRewriteModel.readProjectionSnapshot({ ...params, keys: [] }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("a stale or caller-modified snapshot cannot authorize a projection write", async () => {
    const scope = await openAt({
      organizationId: "org-snapshot-not-authority",
      sessionId: "owner",
      root: "root",
    });
    const params = { scope, wire: "anthropic:messages", keys: [], now: T0 };
    await OpenAppaRewriteModel.commitProjection({
      ...params,
      expectedRevision: 0,
      state: Buffer.from("first-head"),
      pairs: [],
    });
    const snapshot = await OpenAppaRewriteModel.readProjectionSnapshot(params);
    await OpenAppaRewriteModel.commitProjection({
      ...params,
      expectedRevision: 1,
      state: Buffer.from("new-head"),
      pairs: [],
    });
    snapshot.head.state.fill(0);
    await expect(
      OpenAppaRewriteModel.commitProjection({
        ...snapshot,
        wire: params.wire,
        expectedRevision: snapshot.head.revision,
        state: Buffer.from("forged-head"),
        pairs: [bytes("forged", "a", "b")],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await pairCount(scope)).toBe(1);
    expect(
      await OpenAppaRewriteModel.readHead(scope, params.wire, { now: T0 }),
    ).toMatchObject({
      revision: 2,
      state: Buffer.from("new-head"),
    });
    await db
      .update(schema.openappaRewriteGroupsTable)
      .set({ status: "expired" });
    await expect(
      OpenAppaRewriteModel.commitProjection({
        ...snapshot,
        wire: params.wire,
        expectedRevision: 2,
        pairs: [],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test("legacy and due projection snapshots use locked initialization or expiry guards", async () => {
    const scope = await openAt({
      organizationId: "org-snapshot-slow",
      sessionId: "owner",
      root: "root",
      idleTtlMs: 1_000,
    });
    const state = Buffer.from("legacy-head");
    const params = { scope, wire: "anthropic:messages", keys: [], now: T0 };
    await db.insert(schema.openappaRewriteHeadsTable).values({
      organizationId: scope.organizationId,
      groupId: scope.groupId,
      sessionId: scope.sessionId,
      wire: params.wire,
      revision: 7,
      state,
      stateDigest: createHash("sha256").update(state).digest("hex"),
      updatedAt: T0,
    });
    const statements: string[] = [];
    await countStatements(
      async () => {
        const snapshot =
          await OpenAppaRewriteModel.readProjectionSnapshot(params);
        expect(snapshot).toMatchObject({
          head: { revision: 7, state },
          headInitialized: true,
          readOnlyNoopEligible: false,
        });
      },
      (args) => statements.push(String(args[0])),
    );
    expect(
      statements.some((statement) =>
        statement.toUpperCase().includes("FOR UPDATE"),
      ),
    ).toBe(true);
    expect(await pairCount(scope)).toBe(1);
    const renewed = await OpenAppaRewriteModel.readProjectionSnapshot({
      ...params,
      now: later(OPENAPPA_REWRITE_TOUCH_SLACK_MS + 1),
    });
    expect(renewed.readOnlyNoopEligible).toBe(false);
    expect(renewed.scope.expiresAt.getTime()).toBeGreaterThan(
      scope.expiresAt.getTime(),
    );
    const dueAt = new Date(renewed.scope.expiresAt.getTime() + 1);
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: scope.organizationId,
      sessionId: scope.sessionId,
      operationId: "pending-snapshot",
      root: scope.root,
      status: "pending",
      input: { call: "x" },
      createdAt: dueAt,
    });
    const pending = await OpenAppaRewriteModel.readProjectionSnapshot({
      ...params,
      now: dueAt,
    });
    expect(pending.readOnlyNoopEligible).toBe(false);
    expect(pending.scope.expiresAt.getTime()).toBeGreaterThan(dueAt.getTime());
    await db.delete(schema.openappaOperationsTable);
    await expect(
      OpenAppaRewriteModel.readProjectionSnapshot({
        ...params,
        now: new Date(pending.scope.expiresAt.getTime() + 1),
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
    const [expired] = await db.select().from(schema.openappaRewriteGroupsTable);
    expect(expired.status).toBe("expired");
  });

  test("batches authorized parent and fork enrollment with owner-tagged pairs in one query", async () => {
    const source = await openAt({
      organizationId: "org-lineage-batch",
      sessionId: "source",
      root: "source-root",
    });
    const fork = await openAt({
      organizationId: source.organizationId,
      sessionId: "fork",
      root: "fork-root",
      forkedFrom: source.sessionId,
    });
    const child = await openAt({
      organizationId: source.organizationId,
      sessionId: "child",
      root: fork.root,
      parentId: fork.sessionId,
    });
    for (const owner of [source, fork, child]) {
      await OpenAppaRewriteModel.appendBatch(
        owner,
        [bytes("same-key", owner.sessionId, "approved")],
        { now: T0 },
      );
    }
    const stranger = await openAt({
      organizationId: source.organizationId,
      sessionId: "stranger",
      root: fork.root,
    });
    await OpenAppaRewriteModel.appendBatch(
      stranger,
      [bytes("same-key", "foreign", "foreign")],
      { now: T0 },
    );
    const before = await db.select().from(schema.openappaRewriteGroupsTable);
    const params = {
      organizationId: child.organizationId,
      sessionId: child.sessionId,
      callerId: "caller",
      scope: child,
      keys: ["missing", "same-key", "same-key"],
      now: T0,
    };
    expect(
      await countStatements(async () => {
        const owners = await OpenAppaRewriteModel.loadLineageBatch(params);
        expect(owners.map((owner) => owner.scope.sessionId)).toEqual([
          "child",
          "source",
          "fork",
        ]);
        expect(owners.map((owner) => owner.pairs)).toEqual([
          [bytes("same-key", "child", "approved")],
          [bytes("same-key", "source", "approved")],
          [bytes("same-key", "fork", "approved")],
        ]);
      }),
    ).toBe(1);
    expect(await db.select().from(schema.openappaRewriteGroupsTable)).toEqual(
      before,
    );
    await expect(
      OpenAppaRewriteModel.loadLineageBatch({ ...params, callerId: "foreign" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    for (const scope of [
      { ...child, groupId: "foreign" },
      { ...child, root: "foreign" },
      { ...child, epoch: 2 },
      { ...child, protocolVersion: 2 as unknown as 1 },
      { ...child, organizationId: "foreign" },
      { ...child, sessionId: "stranger" },
    ]) {
      await expect(
        OpenAppaRewriteModel.loadLineageBatch({ ...params, scope }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await db
      .update(schema.openappaRewritePairsTable)
      .set({ originalDigest: "0".repeat(64) })
      .where(eq(schema.openappaRewritePairsTable.sessionId, "source"));
    await expect(
      OpenAppaRewriteModel.loadLineageBatch(params),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Replay record conflict",
    });
  });

  test("lineage batches reject missing, cyclic, foreign-caller, and truncated ancestry", async () => {
    const source = await openAt({
      organizationId: "org-lineage-invalid",
      sessionId: "source",
      root: "root",
    });
    const child = await openAt({
      organizationId: source.organizationId,
      sessionId: "child",
      root: "root",
      parentId: "source",
    });
    const params = {
      organizationId: child.organizationId,
      sessionId: child.sessionId,
      callerId: "caller",
      scope: child,
      keys: [],
      now: T0,
    };
    for (const mutation of [
      { parentId: "child" },
      { parentId: "missing" },
      { parentId: null, callerId: "foreign" },
      { parentId: null, callerId: "caller", sessionId: "mismatched-actor" },
    ]) {
      await db
        .update(schema.openappaSessionsTable)
        .set(mutation)
        .where(
          eq(
            schema.openappaSessionsTable.actor,
            openappaActor(source.sessionId),
          ),
        );
      await expect(
        OpenAppaRewriteModel.loadLineageBatch(params),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    for (let index = 0; index <= OPENAPPA_REWRITE_MAX_FORK_DEPTH; index++) {
      await native({
        organizationId: "org-lineage-truncated",
        sessionId: `s${index}`,
        root: "root",
        parentId: index === 0 ? null : `s${index - 1}`,
      });
    }
    await expect(
      OpenAppaRewriteModel.loadLineageBatch({
        organizationId: "org-lineage-truncated",
        sessionId: `s${OPENAPPA_REWRITE_MAX_FORK_DEPTH}`,
        callerId: "caller",
        keys: [],
        now: T0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("strict lineage validates each owner's enrollment and excludes unfinished reservations", async () => {
    const source = await openAt({
      organizationId: "org-lineage-enrollment",
      sessionId: "source",
      root: "source-root",
    });
    const child = await openAt({
      organizationId: source.organizationId,
      sessionId: "child",
      root: "child-root",
      parentId: "source",
    });
    const params = {
      organizationId: child.organizationId,
      sessionId: child.sessionId,
      callerId: "caller",
      scope: child,
      keys: ["k"],
      now: T0,
    };
    await expect(
      OpenAppaRewriteModel.loadLineageBatch(params),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Discovery mode keeps each independently enrolled group attached to its owner.
    expect(
      (
        await OpenAppaRewriteModel.loadLineageBatch({
          ...params,
          scope: undefined,
        })
      ).map((owner) => owner.scope),
    ).toEqual([child, source]);
    await db
      .update(schema.openappaRewriteRootsTable)
      .set({ groupId: source.groupId })
      .where(eq(schema.openappaRewriteRootsTable.nativeRoot, child.root));
    const aligned = { ...params, scope: { ...child, groupId: source.groupId } };
    await OpenAppaRewriteModel.reservePair({
      scope: source,
      pair: bytes("k", "identity", "reserved"),
      reservationId: "00000000-0000-4000-8000-000000000005",
      maxBytes: 100,
      now: T0,
    });
    expect(
      (await OpenAppaRewriteModel.loadLineageBatch(aligned)).map(
        (owner) => owner.pairs,
      ),
    ).toEqual([[], []]);
    for (const mutation of [
      { protocolVersion: 2 },
      { protocolVersion: 1, epoch: 2 },
    ]) {
      await db
        .update(schema.openappaRewriteGroupsTable)
        .set(mutation)
        .where(eq(schema.openappaRewriteGroupsTable.groupId, source.groupId));
      await expect(
        OpenAppaRewriteModel.loadLineageBatch(aligned),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await db
      .delete(schema.openappaRewriteGroupsTable)
      .where(eq(schema.openappaRewriteGroupsTable.groupId, source.groupId));
    await expect(
      OpenAppaRewriteModel.loadLineageBatch(aligned),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("lineage query bounds the total owner/key slots rather than silently truncating", async () => {
    const source = await openAt({
      organizationId: "org-lineage-limit",
      sessionId: "source",
      root: "root",
    });
    const child = await openAt({
      organizationId: source.organizationId,
      sessionId: "child",
      root: "root",
      parentId: "source",
    });
    await expect(
      OpenAppaRewriteModel.loadLineageBatch({
        organizationId: child.organizationId,
        sessionId: child.sessionId,
        callerId: "caller",
        scope: child,
        keys: Array.from(
          { length: Math.floor(OPENAPPA_REWRITE_MAX_BATCH / 2) + 1 },
          (_, index) => `k${index}`,
        ),
        now: T0,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Replay record limit exceeded",
    });
  });

  test("receipt lineage omits unenrolled or expired owners and uses fresh locked guards when due", async () => {
    const source = await openAt({
      organizationId: "org-lineage-slow",
      sessionId: "source",
      root: "root",
      idleTtlMs: 1_000,
    });
    await OpenAppaRewriteModel.appendBatch(
      source,
      [bytes("k", "original", "approved")],
      { now: T0 },
    );
    await native({
      organizationId: source.organizationId,
      sessionId: "child",
      root: "unenrolled-root",
      parentId: "source",
    });
    const params = {
      organizationId: source.organizationId,
      sessionId: "child",
      callerId: "caller",
      keys: ["k"],
      now: T0,
    };
    expect(await OpenAppaRewriteModel.loadLineageBatch(params)).toEqual([
      { scope: source, pairs: [bytes("k", "original", "approved")] },
    ]);
    const statements: string[] = [];
    await countStatements(
      async () => {
        const owners = await OpenAppaRewriteModel.loadLineageBatch({
          ...params,
          now: later(OPENAPPA_REWRITE_TOUCH_SLACK_MS + 1),
        });
        expect(owners).toHaveLength(1);
        expect(owners[0].scope.expiresAt.getTime()).toBeGreaterThan(
          source.expiresAt.getTime(),
        );
        expect(owners[0].pairs).toEqual([bytes("k", "original", "approved")]);
      },
      (args) => statements.push(String(args[0])),
    );
    expect(
      statements.some((statement) =>
        statement.toUpperCase().includes("FOR UPDATE"),
      ),
    ).toBe(true);
    await db
      .update(schema.openappaRewriteGroupsTable)
      .set({ status: "expired" });
    expect(await OpenAppaRewriteModel.loadLineageBatch(params)).toEqual([]);
    await expect(
      OpenAppaRewriteModel.loadLineageBatch({
        ...params,
        sessionId: "source",
        scope: source,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  test("healthy reads use one statement and the retention indexes", async () => {
    const scope = await openAt({
      organizationId: "org-budget",
      sessionId: "session",
      root: "root-budget",
    });
    const awkward = 'a"b,c}d\\e';
    await OpenAppaRewriteModel.appendBatch(
      scope,
      [bytes(awkward, "o", "r"), bytes("plain", "o", "r")],
      { now: T0 },
    );
    await OpenAppaRewriteModel.compareAndSwapHead({
      scope,
      wire: "anthropic:messages",
      expectedRevision: 0,
      state: Buffer.from("head"),
      now: T0,
    });
    const counts = {
      verify: await countStatements(() =>
        OpenAppaRewriteModel.verify(scope, { now: T0 }),
      ),
      load: await countStatements(() =>
        OpenAppaRewriteModel.loadBatch(scope, [awkward, "missing"], {
          now: T0,
        }),
      ),
      head: await countStatements(() =>
        OpenAppaRewriteModel.readHead(scope, "anthropic:messages", { now: T0 }),
      ),
      existing: await countStatements(() =>
        OpenAppaRewriteModel.openExisting({
          organizationId: scope.organizationId,
          sessionId: scope.sessionId,
          protocolVersion: 1,
          now: T0,
        }),
      ),
      append: await countStatements(() =>
        OpenAppaRewriteModel.appendBatch(scope, [bytes("fresh", "o", "r")], {
          now: T0,
        }),
      ),
    };
    expect(counts).toEqual({
      verify: 1,
      load: 1,
      head: 1,
      existing: 1,
      append: 3,
    });
    const loaded = await OpenAppaRewriteModel.loadBatch(scope, [awkward], {
      now: T0,
    });
    same(loaded[0].original, Buffer.from("o"));
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename IN (
        'openappa_rewrite_groups',
        'openappa_rewrite_pairs',
        'openappa_rewrite_heads',
        'openappa_rewrite_roots'
      )
    `);
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "openappa_rewrite_groups_expiry_idx",
        "openappa_rewrite_groups_unswept_idx",
        "openappa_rewrite_roots_group_idx",
        "openappa_rewrite_pairs_organization_id_group_id_session_id_frag",
        "openappa_rewrite_heads_organization_id_group_id_session_id_wire",
        "openappa_rewrite_groups_organization_id_group_id_pk",
      ]),
    );
  });

  test("records PGlite operation timings without a latency threshold", async () => {
    const scope = await openAt({
      organizationId: "org-bench",
      sessionId: "session",
      root: "root-bench",
      maxEntries: 512,
      maxBytes: OPENAPPA_REWRITE_MAX_BYTES,
    });
    const batch = Array.from({ length: 64 }, (_, index) =>
      bytes(`family:item:${index}`, `o${index}`, `r${index}`),
    );
    const appendMs = await elapsed(() =>
      OpenAppaRewriteModel.appendBatch(scope, batch, { now: T0 }),
    );
    const loadMs = await elapsed(() =>
      OpenAppaRewriteModel.loadBatch(
        scope,
        batch.map((pair) => pair.fragmentKey),
        { now: T0 },
      ),
    );
    const headMs = await elapsed(() =>
      OpenAppaRewriteModel.readHead(scope, "anthropic:messages", { now: T0 }),
    );
    const verifyMs = await elapsed(() =>
      OpenAppaRewriteModel.verify(scope, { now: T0 }),
    );
    const existingMs = await elapsed(() =>
      OpenAppaRewriteModel.openExisting({
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        protocolVersion: 1,
        now: T0,
      }),
    );
    const timings = { appendMs, loadMs, headMs, verifyMs, existingMs };
    await writeFile(
      "/tmp/openappa-rewrite-bench.json",
      JSON.stringify(timings),
    );
    expect(Object.values(timings).every((ms) => ms >= 0)).toBe(true);
  });
});

async function countStatements(
  run: () => Promise<unknown>,
  observe?: (args: unknown[]) => void,
): Promise<number> {
  const client = (
    db as unknown as {
      $client: {
        query: (...args: unknown[]) => Promise<unknown>;
        transaction: (
          fn: (tx: {
            query: (...args: unknown[]) => Promise<unknown>;
          }) => Promise<unknown>,
        ) => Promise<unknown>;
      };
    }
  ).$client;
  let count = 0;
  const originalQuery = client.query.bind(client);
  const originalTransaction = client.transaction.bind(client);
  client.query = async (...args: unknown[]) => {
    count += 1;
    observe?.(args);
    return originalQuery(...args);
  };
  client.transaction = async (fn) =>
    originalTransaction(async (tx) => {
      const originalTxQuery = tx.query.bind(tx);
      tx.query = async (...args: unknown[]) => {
        count += 1;
        observe?.(args);
        return originalTxQuery(...args);
      };
      return fn(tx);
    });
  try {
    await run();
    return count;
  } finally {
    client.query = originalQuery;
    client.transaction = originalTransaction;
  }
}

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}
