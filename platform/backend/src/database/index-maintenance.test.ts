import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";
import { dropLegacyPayloadTrgmIndexes } from "./index-maintenance";

async function indexExists(name: string): Promise<boolean> {
  const result = await db.execute(
    sql`select to_regclass(${name}) as index_oid`,
  );
  return result.rows[0]?.index_oid != null;
}

describe("dropLegacyPayloadTrgmIndexes", () => {
  test("drops the legacy payload indexes when present", async () => {
    // The test schema never creates the trgm indexes (pg_trgm is unavailable
    // under PGlite, and migration 0116 no longer creates them anyway), so
    // stand in plain indexes under the legacy names.
    await db.execute(
      sql.raw(
        'CREATE INDEX IF NOT EXISTS "interactions_request_trgm_idx" ON "interactions" (id)',
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE INDEX IF NOT EXISTS "interactions_response_trgm_idx" ON "interactions" (id)',
      ),
    );

    // concurrently: false — PGlite rejects DROP INDEX CONCURRENTLY; production
    // always uses the concurrent form (see the option's doc).
    await dropLegacyPayloadTrgmIndexes({ concurrently: false });

    expect(await indexExists("interactions_request_trgm_idx")).toBe(false);
    expect(await indexExists("interactions_response_trgm_idx")).toBe(false);
  });

  test("is a no-op when the indexes are already gone", async () => {
    await expect(
      dropLegacyPayloadTrgmIndexes({ concurrently: false }),
    ).resolves.toBeUndefined();
    expect(await indexExists("interactions_request_trgm_idx")).toBe(false);
  });
});
