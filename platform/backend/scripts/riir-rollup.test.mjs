import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import config from "../src/config.ts";
import db, { initializeDatabase, schema } from "../src/database/index.ts";
import { llmUsageRollup } from "../src/services/llm-usage-rollup.ts";

test("native rollup worker matches TypeScript hourly, daily and corrected usage", { timeout: 120_000 }, async () => {
  assert.equal(new URL(config.database.url).pathname, "/archestra_riir_test");
  await initializeDatabase();
  const org = randomUUID();
  await db.insert(schema.organizationsTable).values({ id: org, name: org, slug: org, createdAt: new Date() });
  // Seed a watermark one hour behind the cutoff so the test does not backfill
  // a whole day over the tunnel. The older, marked hour exercises daily sums.
  const { rows: [{ cutoff }] } = await db.execute(sql`
    SELECT date_trunc('hour', now() - interval '15 minutes', 'UTC') AS cutoff
  `);
  const stamp = new Date(cutoff);
  stamp.setUTCDate(stamp.getUTCDate() - 1);
  stamp.setUTCHours(23, 10, 0, 0);
  const watermark = new Date(new Date(cutoff).getTime() - 3_600_000);
  const seedWatermark = () => db.insert(schema.llmUsageRollupStateTable).values({
    id: 1, rolledThrough: watermark,
  });
  await seedWatermark();
  const plain = randomUUID();
  const split = randomUUID();
  await db.insert(schema.interactionsTable).values([plain, split].map((id) => ({
    id, createdAt: stamp, type: "openai:chatCompletions", request: {}, response: {},
    model: "fixture-model", inputTokens: 120, outputTokens: 10, inputTokensEstimated: id === plain,
    cost: "0.001", baselineCost: "0.002", cacheSavings: "0.0001",
  })));
  const components = ["fixture-model", "fixture-advisor"].map((model, index) => ({
    model, kind: index === 0 ? "message" : "advisor_message", inputTokens: 100 * (index + 1),
    outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    prices: { input: "2", cacheRead: "0.5" }, cost: "0.0002",
  }));
  await db.insert(schema.interactionBillingTable).values({
    interactionId: split, organizationId: org, billingMode: "metered", fingerprint: split,
    usage: { version: 1, mode: "enforce", status: "complete", issues: [], cost: "0.0004", components },
  });

  async function snapshot() {
    const order = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    return {
      hourly: order(await db.select().from(schema.llmUsageHourlyTable)),
      daily: order(await db.select().from(schema.llmUsageDailyTable)),
      dirty: await db.select().from(schema.llmUsageRollupDirtyTable),
      watermark: await db.select().from(schema.llmUsageRollupStateTable),
    };
  }
  async function legacy() {
    await llmUsageRollup.run({ throttleRatio: 0 });
    return snapshot();
  }
  async function correct(cost) {
    await db.update(schema.interactionsTable).set({ cost }).where(eq(schema.interactionsTable.id, plain));
  }
  const first = await legacy();
  assert.equal(first.hourly.length, 2);
  assert.equal(first.daily.length, 2);
  assert.deepEqual(first.dirty, []);
  await correct("0.003");
  const corrected = await legacy();
  assert.notDeepEqual(corrected.daily, first.daily);
  await db.execute(sql`TRUNCATE llm_usage_hourly, llm_usage_daily, llm_usage_rollup_dirty, llm_usage_rollup_state`);
  await seedWatermark();
  await correct("0.001");

  async function runWorker(completed) {
    const runtime = await mkdtemp(join(tmpdir(), "riir-worker-"));
    const marker = join(runtime, "worker.ready");
    const proc = spawn("../archestra-rs/target/debug/archestra-worker", [], {
      env: { ...process.env, ARCHESTRA_TASK_QUEUE_RUST_ROLLUP_ENABLED: "true",
        ARCHESTRA_NATIVE_RUNTIME_DIR: runtime, PATH: "" },
      stdio: "inherit",
    });
    const exited = once(proc, "exit");
    try {
      const deadline = Date.now() + 55_000;
      while (Date.now() < deadline) {
        assert.equal(proc.exitCode, null);
        const result = await db.execute(sql`
          SELECT status, count(*)::int AS count FROM tasks
          WHERE task_type = 'llm_usage_rollup' GROUP BY status ORDER BY status
        `);
        assert.ok(!result.rows.some(({ status }) => status === "dead"));
        if (result.rows.some((row) => row.status === "completed" && row.count === completed) &&
            await stat(marker).catch((error) => {
              if (error.code !== "ENOENT") throw error;
              return null;
            })) {
          assert.deepEqual(result.rows, [{ status: "completed", count: completed }, { status: "pending", count: 1 }]);
          return await snapshot();
        }
        await delay(200);
      }
      assert.fail("native rollup did not complete");
    } finally {
      proc.kill();
      assert.deepEqual(await exited, [0, null]);
      await assert.rejects(stat(marker), { code: "ENOENT" });
      await rmdir(runtime);
    }
  }
  assert.deepEqual(await runWorker(1), first);
  await correct("0.003");
  await db.execute(sql`UPDATE tasks SET scheduled_for = now() WHERE task_type = 'llm_usage_rollup' AND status = 'pending'`);
  assert.deepEqual(await runWorker(2), corrected);
});
