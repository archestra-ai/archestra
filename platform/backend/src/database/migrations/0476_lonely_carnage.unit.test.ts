import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

// Exercise both the production path (index retired before the migration) and
// fresh-install replay (historical migrations create the index on empty tables).
test.each([
  false,
  true,
])("removes compression accounting while preserving billing and settings (index retired: %s)", async (indexRetired) => {
  const database = new PGlite();
  try {
    await database.exec(`
        CREATE TABLE interactions (
          id text PRIMARY KEY, cost numeric(13, 10), cache_savings numeric(13, 10),
          billing_mode text, input_tokens integer, output_tokens integer,
          toon_tokens_before integer, toon_tokens_after integer,
          toon_cost_savings numeric(13, 10), toon_skip_reason varchar
        );
        CREATE INDEX interactions_statistics_covering_idx ON interactions (cost, toon_cost_savings, cache_savings);
        CREATE INDEX interactions_agent_id_idx ON interactions (id);
        CREATE TABLE organization (id text PRIMARY KEY, name text, convert_tool_results_to_toon boolean, compression_scope varchar);
        CREATE TABLE team (id text PRIMARY KEY, name text, convert_tool_results_to_toon boolean);
        INSERT INTO interactions VALUES ('request', 1.25, 0.30, 'metered', 200, 100, 400, 200, 0.20, null);
        INSERT INTO organization VALUES ('org', 'Example organization', true, 'team');
        INSERT INTO team VALUES ('team', 'Example team', true);
      `);
    if (indexRetired) {
      // PGlite cannot run CONCURRENTLY; the production wrapper uses it.
      await database.exec('DROP INDEX "interactions_statistics_covering_idx"');
    }
    const migration = fs.readFileSync(
      new URL("./0476_lonely_carnage.sql", import.meta.url),
      "utf8",
    );
    await database.exec(`BEGIN; ${migration} COMMIT;`);
    expect((await database.query("SELECT * FROM interactions")).rows).toEqual([
      {
        id: "request",
        cost: "1.2500000000",
        cache_savings: "0.3000000000",
        billing_mode: "metered",
        input_tokens: 200,
        output_tokens: 100,
      },
    ]);
    expect((await database.query("SELECT * FROM organization")).rows).toEqual([
      { id: "org", name: "Example organization" },
    ]);
    expect((await database.query("SELECT * FROM team")).rows).toEqual([
      { id: "team", name: "Example team" },
    ]);
    expect(
      (
        await database.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'interactions' ORDER BY indexname",
        )
      ).rows,
    ).toEqual([
      { indexname: "interactions_agent_id_idx" },
      { indexname: "interactions_pkey" },
    ]);
  } finally {
    await database.close();
  }
});
