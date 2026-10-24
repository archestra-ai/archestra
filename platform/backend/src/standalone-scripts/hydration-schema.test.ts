import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { assertMatchingHydrationSchemas } from "./hydration-schema";

test("permits matching schemas and refuses extra source storage columns before copying data", async () => {
  const source = new PGlite();
  const target = new PGlite();
  try {
    await source.exec("CREATE TABLE secret (id text, secret jsonb)");
    await target.exec("CREATE TABLE secret (id text, secret jsonb)");
    await expect(
      assertMatchingHydrationSchemas({ source, target }),
    ).resolves.toBeUndefined();
    await source.exec("ALTER TABLE secret ADD COLUMN storage_kind text");
    await expect(
      assertMatchingHydrationSchemas({ source, target }),
    ).rejects.toThrow("schemas must match");
    expect((await target.query("SELECT * FROM secret")).rows).toEqual([]);
  } finally {
    await source.close();
    await target.close();
  }
});
