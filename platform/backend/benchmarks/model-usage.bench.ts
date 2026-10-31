/**
 * Synthetic PGlite model drill-down benchmark. Run the same file on base and
 * patched revisions with an otherwise idle machine, from platform/:
 * ARCHESTRA_DATABASE_URL=postgresql://test:test@localhost:5432/test pnpm --dir backend benchmark:queries model-usage
 * These timings cover the full model method (page, count and timeline), not HTTP.
 */
import { sql } from "drizzle-orm";
import db from "@/database";
import StatisticsModel from "@/models/statistics";
import { expect, test } from "@/test";

test("model drill-down with sparse, broad and absent model matches", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  // All data and the concurrent-startup equivalent index exist only in this
  // test's disposable database. No development or shared DB is touched.
  await db.execute(sql`
    INSERT INTO interactions
      (id, profile_id, user_id, type, model, request, response, cost,
       input_tokens, output_tokens, created_at)
    SELECT gen_random_uuid(), ${agent.id}::uuid, ${user.id}, 'openai:chatCompletions',
      CASE WHEN n % 100 = 0 THEN 'sparse-model'
           WHEN n % 2 = 0 THEN 'broad-model' ELSE 'other-model' END,
      jsonb_build_object('ordinal', n), '{}'::jsonb, 1, 10, 5,
      now() - (n % 29) * interval '1 day'
    FROM generate_series(1, 30000) n
  `);
  await db.execute(sql`
    INSERT INTO interaction_billing
      (interaction_id, fingerprint, organization_id, billing_mode, usage)
    SELECT id, id::text, ${org.id}, 'metered', jsonb_build_object(
      'mode', 'enforce', 'components', jsonb_build_array(jsonb_build_object(
        'kind', 'message', 'model', CASE WHEN (request->>'ordinal')::int % 100 = 1
          THEN 'sparse-model' ELSE model END,
        'inputTokens', 10, 'outputTokens', 5, 'cacheReadTokens', 0,
        'cacheWriteTokens', 0, 'cacheWrite1hTokens', 0, 'cost', '1'
      )))
    FROM interactions WHERE (request->>'ordinal')::int % 10 IN (0, 1)
  `);
  await db.execute(sql`
    CREATE INDEX interactions_model_created_at_idx
    ON interactions (model, created_at, id)
  `);
  await db.execute(sql`ANALYZE interactions`);
  await db.execute(sql`ANALYZE interaction_billing`);
  for (const [model, requests] of [
    ["sparse-model", 600],
    ["broad-model", 14700],
    ["missing-model", 0],
  ] as const) {
    const read = () =>
      StatisticsModel.getModelUsage({
        model,
        groupBy: "person",
        timeframe: "30d",
        organizationId: org.id,
        limit: 100,
        offset: 0,
      });
    const warmup = await read();
    expect(warmup.data.reduce((sum, row) => sum + row.requests, 0)).toBe(
      requests,
    );
    expect(warmup.data.reduce((sum, row) => sum + row.billedCost, 0)).toBe(
      requests,
    );
    expect(
      warmup.data
        .flatMap((row) => row.timeSeries)
        .reduce((sum, point) => sum + point.billedCost, 0),
    ).toBe(requests);
    const samples = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now();
      await read();
      samples.push(Math.round(performance.now() - start));
    }
    process.stdout.write(
      `${JSON.stringify({
        model,
        samplesMs: samples,
        medianMs: [...samples].sort((a, b) => a - b)[2],
      })}\n`,
    );
  }
}, 120_000);
