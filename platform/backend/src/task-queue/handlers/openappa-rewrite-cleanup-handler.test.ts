import { vi } from "vitest";

vi.mock("@/logging");

import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";
import { openappaActor } from "@/openappa/actor";
import type { OpenAppaRewritePair } from "@/types/openappa-rewrite";
import { handleOpenAppaRewriteCleanup } from "./openappa-rewrite-cleanup-handler";

const PAST = new Date("2020-01-01T00:00:00.000Z");

async function seedExpiredTree(params: {
  organizationId: string;
  sessionId: string;
  root: string;
  pairs: number;
}) {
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(params.sessionId),
    root: params.root,
    organizationId: params.organizationId,
    callerId: "caller",
    sessionId: params.sessionId,
    parentId: null,
    forkedFrom: null,
    startDecision: { decision: "ack" },
  });
  const scope = await OpenAppaRewriteModel.open({
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    protocolVersion: 1,
    idleTtlMs: 1_000,
    now: PAST,
  });
  const batch: OpenAppaRewritePair[] = Array.from(
    { length: params.pairs },
    (_, index) => ({
      fragmentKey: `pair-${index}`,
      original: Buffer.from(`original-${index}`),
      rewritten: Buffer.from(`rewritten-${index}`),
    }),
  );
  await OpenAppaRewriteModel.appendBatch(scope, batch, { now: PAST });
}

async function pairCount(organizationId: string) {
  const [{ total }] = await db
    .select({ total: count() })
    .from(schema.openappaRewritePairsTable)
    .where(eq(schema.openappaRewritePairsTable.organizationId, organizationId));
  return Number(total);
}

describe("handleOpenAppaRewriteCleanup", () => {
  const originalEnabled = config.openappa.enabled;

  beforeEach(() => {
    vi.clearAllMocks();
    config.openappa.enabled = originalEnabled;
  });

  afterEach(() => {
    config.openappa.enabled = originalEnabled;
    vi.mocked(logger.info).mockReset();
  });

  test("purges an expired payload while OpenAPPA is disabled", async () => {
    config.openappa.enabled = false;
    await seedExpiredTree({
      organizationId: "org-cleanup-disabled",
      sessionId: "session-disabled",
      root: "root-disabled",
      pairs: 1,
    });

    await handleOpenAppaRewriteCleanup();

    expect(await pairCount("org-cleanup-disabled")).toBe(0);
  });

  test("deletes one batch of 500 and finishes the remainder on the next tick", async () => {
    await seedExpiredTree({
      organizationId: "org-cleanup-batch",
      sessionId: "session-batch",
      root: "root-batch",
      pairs: 501,
    });

    await handleOpenAppaRewriteCleanup();
    expect(await pairCount("org-cleanup-batch")).toBe(1);

    await handleOpenAppaRewriteCleanup();
    expect(await pairCount("org-cleanup-batch")).toBe(0);
  });

  test("logs a generic failure without the thrown secret", async () => {
    const secret = "synthetic-secret-must-not-be-logged";
    vi.mocked(logger.info).mockImplementation(() => {
      throw new Error(secret);
    });

    await expect(handleOpenAppaRewriteCleanup()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      secret,
    );
  });
});
