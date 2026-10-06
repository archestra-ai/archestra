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
    vi.spyOn(performance, "now").mockReturnValue(0);
    config.openappa.enabled = originalEnabled;
  });

  afterEach(() => {
    config.openappa.enabled = originalEnabled;
    vi.mocked(logger.info).mockReset();
    vi.restoreAllMocks();
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

  test("drains a full batch and its remainder in the same tick", async () => {
    await seedExpiredTree({
      organizationId: "org-cleanup-batch",
      sessionId: "session-batch",
      root: "root-batch",
      pairs: 501,
    });

    await handleOpenAppaRewriteCleanup();
    expect(await pairCount("org-cleanup-batch")).toBe(0);
  });

  test("logs a generic failure without the thrown secret", async () => {
    const secret = "synthetic-secret-must-not-be-logged";
    const error = new Error(secret);
    vi.mocked(logger.info).mockImplementation(() => {
      throw error;
    });

    await expect(handleOpenAppaRewriteCleanup()).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      secret,
    );
  });

  // Task logic only: mock the handler-model service boundary, never DB interfaces.
  // Keep .test.ts because the real handler's import graph includes the model.
  describe("bounded batch draining", () => {
    beforeEach(() => {
      vi.spyOn(OpenAppaRewriteModel, "expireInactive").mockResolvedValue(0);
    });

    test.each([
      0, 27, 499,
    ])("stops immediately after an initial partial batch of %i rows", async (deleted) => {
      vi.mocked(OpenAppaRewriteModel.expireInactive).mockResolvedValue(deleted);

      await expect(handleOpenAppaRewriteCleanup()).resolves.toBeUndefined();

      expect(
        OpenAppaRewriteModel.expireInactive,
      ).toHaveBeenCalledExactlyOnceWith({ batchSize: 500 });
      expect(logger.info).toHaveBeenCalledWith(
        { deleted },
        "OpenAPPA rewrite cleanup complete",
      );
    });

    test.each([
      0, 17,
    ])("continues full batches, sums deleted rows, and stops on a remainder of %i", async (remainder) => {
      vi.mocked(OpenAppaRewriteModel.expireInactive)
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(500)
        .mockResolvedValue(remainder);

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(3);
      expect(vi.mocked(OpenAppaRewriteModel.expireInactive).mock.calls).toEqual(
        [[{ batchSize: 500 }], [{ batchSize: 500 }], [{ batchSize: 500 }]],
      );
      expect(logger.info).toHaveBeenCalledWith(
        { deleted: 1_000 + remainder },
        "OpenAPPA rewrite cleanup complete",
      );
    });

    test("caps a persistent backlog at 5000 rows per tick with fresh limits on the next tick", async () => {
      vi.mocked(OpenAppaRewriteModel.expireInactive).mockResolvedValue(500);

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(10);
      expect(
        vi
          .mocked(OpenAppaRewriteModel.expireInactive)
          .mock.calls.every(([params]) => params?.batchSize === 500),
      ).toBe(true);
      expect(logger.info).toHaveBeenLastCalledWith(
        { deleted: 5_000 },
        "OpenAPPA rewrite cleanup complete",
      );

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(20);
      expect(logger.info).toHaveBeenLastCalledWith(
        { deleted: 5_000 },
        "OpenAPPA rewrite cleanup complete",
      );
    });

    test("continues just below the work budget and stops exactly at the deadline", async () => {
      let now = 100;
      vi.mocked(performance.now).mockImplementation(() => now);
      vi.mocked(OpenAppaRewriteModel.expireInactive)
        .mockImplementationOnce(async () => {
          now += 1_999;
          return 500;
        })
        .mockImplementationOnce(async () => {
          now += 1;
          return 500;
        });

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        { deleted: 1_000 },
        "OpenAPPA rewrite cleanup complete",
      );
    });

    test("finishes a slow batch without starting another and resets the work budget next tick", async () => {
      let now = 100;
      vi.mocked(performance.now).mockImplementation(() => now);
      vi.mocked(OpenAppaRewriteModel.expireInactive).mockImplementation(
        async () => {
          now += 2_500;
          return 500;
        },
      );

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenLastCalledWith(
        { deleted: 500 },
        "OpenAPPA rewrite cleanup complete",
      );

      await handleOpenAppaRewriteCleanup();

      expect(OpenAppaRewriteModel.expireInactive).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenLastCalledWith(
        { deleted: 500 },
        "OpenAPPA rewrite cleanup complete",
      );
    });

    test.each([
      false,
      true,
    ])("propagates a model failure without reporting completion (after full batch: %s)", async (afterFullBatch) => {
      const error = new Error("synthetic-secret-must-not-be-logged");
      const expireInactive = vi.mocked(OpenAppaRewriteModel.expireInactive);
      if (afterFullBatch) expireInactive.mockResolvedValueOnce(500);
      expireInactive.mockRejectedValueOnce(error);

      await expect(handleOpenAppaRewriteCleanup()).rejects.toBe(error);

      expect(expireInactive).toHaveBeenCalledTimes(afterFullBatch ? 2 : 1);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "OpenAPPA rewrite cleanup failed",
      );
    });
  });
});
