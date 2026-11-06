/**
 * Roll up a seeded costs_bench database (see seed.sql) the way the
 * `llm_usage_rollup` periodic task does on a deployment with history, but
 * without its pauses, so run-bench.ts times the views over the rollup.
 *
 *   ARCHESTRA_DATABASE_URL=postgresql://…/costs_bench \
 *     TSX_TSCONFIG_PATH=standalone-scripts.tsconfig.json \
 *     node --import tsx src/standalone-scripts/costs-bench/backfill.ts
 *
 * Refuses any database whose name does not start with costs_bench. Prints
 * progress after each run.
 */
import { sql } from "drizzle-orm";
import db, { initializeDatabase } from "@/database";
import { llmUsageRollup } from "@/services/llm-usage-rollup";

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});

async function main() {
  await initializeDatabase();
  const {
    rows: [row],
  } = await db.execute<{ name: string }>(
    sql`SELECT current_database() AS name`,
  );
  if (!row.name.startsWith("costs_bench"))
    throw new Error(
      `Refusing to roll up ${row.name}: not a costs_bench database`,
    );

  const started = Date.now();
  let hours = 0;
  for (;;) {
    const result = await llmUsageRollup.run({
      timeBudgetMs: 60_000,
      throttleRatio: 0,
    });
    hours += result.rolled + result.recomputed;
    process.stdout.write(
      `rolled ${result.rolled}, recomputed ${result.recomputed} (${hours} hours in ${Math.round((Date.now() - started) / 1000)} s)\n`,
    );
    if (result.rolled === 0 && result.recomputed === 0) break;
  }
  process.exit(0);
}
