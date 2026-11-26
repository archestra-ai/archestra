import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { ensureAutoRouter, makeScorerVersion } from "@/test/auto-routing";

const migration = fs.readFileSync(
  path.join(__dirname, "0664_auto_routing_warm_start.sql"),
  "utf8",
);

/** The migration's data steps; the test database already has its columns. */
async function runDataSteps() {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.includes("UPDATE")) await db.execute(sql.raw(statement));
  }
}

describe("learning from past sessions on every router", () => {
  test("only the router that read past sessions before the upgrade keeps learning from them", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const first = await ensureAutoRouter(organizationId, "auto");
    const later = await ensureAutoRouter(organizationId, "auto:later");
    const routers = schema.autoRoutersTable;
    // As the column addition leaves them: every row takes the default.
    await db
      .update(routers)
      .set({ learnFromPastSessions: false })
      .where(inArray(routers.id, [first.id, later.id]));
    await db
      .update(routers)
      .set({ usesPastSessions: true })
      .where(eq(routers.id, first.id));
    await db
      .update(routers)
      .set({ usesPastSessions: false })
      .where(eq(routers.id, later.id));

    await runDataSteps();

    const rows = await db
      .select({ id: routers.id, learn: routers.learnFromPastSessions })
      .from(routers)
      .where(inArray(routers.id, [first.id, later.id]));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.learn]))).toEqual({
      [first.id]: true,
      [later.id]: false,
    });
  });

  test("a scoring run that pinned no payer ends, and a finished one's fit request is kept by router", async ({
    makeOrganization,
  }) => {
    const scorerVersionId = (await makeScorerVersion()).id;
    const backfills = schema.routingBackfillsTable;
    // One active job per organization, so each running one gets its own.
    const job = async (
      values:
        | { status: "running"; phase: "scan" }
        | {
            status: "running" | "done";
            phase: "score";
            scorerApiKeyId?: string;
            fitGeneration?: number;
          },
    ) => {
      const organizationId = (await makeOrganization()).id;
      const router = await ensureAutoRouter(organizationId, "auto");
      await db
        .update(schema.autoRoutersTable)
        .set({ usesPastSessions: true })
        .where(eq(schema.autoRoutersTable.id, router.id));
      const [row] = await db
        .insert(backfills)
        .values({
          organizationId,
          cutoff: new Date(),
          windowStart: new Date(Date.now() - 86_400_000),
          ...(values.phase === "score" && {
            scorerVersionId,
            maxSessions: 10,
            maxCostUsd: "1",
            scannedAt: new Date(),
          }),
          ...values,
        })
        .returning({ id: backfills.id });
      return { id: row.id, routerId: router.id };
    };
    const unpinned = await job({ status: "running", phase: "score" });
    const pinned = await job({
      status: "running",
      phase: "score",
      scorerApiKeyId: randomUUID(),
    });
    const scanning = await job({ status: "running", phase: "scan" });
    const finished = await job({
      status: "done",
      phase: "score",
      fitGeneration: 7,
    });

    await runDataSteps();

    const rows = await db
      .select({
        id: backfills.id,
        status: backfills.status,
        fitGenerations: backfills.fitGenerations,
      })
      .from(backfills)
      .where(
        inArray(
          backfills.id,
          [unpinned, pinned, scanning, finished].map((b) => b.id),
        ),
      );
    expect(
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          { status: row.status, fitGenerations: row.fitGenerations },
        ]),
      ),
    ).toEqual({
      [unpinned.id]: { status: "failed", fitGenerations: null },
      [pinned.id]: { status: "running", fitGenerations: null },
      [scanning.id]: { status: "running", fitGenerations: null },
      [finished.id]: {
        status: "done",
        fitGenerations: { [finished.routerId]: 7 },
      },
    });
  });

  test("the expected traffic factor stays within (0, 100]", async ({
    makeOrganization,
  }) => {
    const router = await ensureAutoRouter((await makeOrganization()).id);
    const setFactor = (factor: string) =>
      db
        .update(schema.autoRoutersTable)
        .set({ expectedTrafficFactor: factor })
        .where(eq(schema.autoRoutersTable.id, router.id));

    await expect(setFactor("0")).rejects.toThrow();
    await expect(setFactor("100.01")).rejects.toThrow();
    await setFactor("100");
    await setFactor("0.5");
  });
});
