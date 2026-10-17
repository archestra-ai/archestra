import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import db from "@/database";

// The native runtime's PostgreSQL store writes these tables with its own SQL.
// These statements are the ones it runs to publish and to read a head, so the
// schema here must accept them and refuse what the store relies on refusing.
describe("0567 OpenAPPA policy revisions", () => {
  test("a publish records the head and its revision, and the head reads back", async () => {
    await publish({ deployment: "org-a", revision: 1, hash: "a".repeat(64) });
    await db.execute(
      sql`UPDATE openappa_deployments SET head = 2 WHERE name = 'org-a' AND head = 1`,
    );
    await db.execute(sql`
      INSERT INTO openappa_policy_files (hash, bytes) VALUES (${"b".repeat(64)}, '\\x00')
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO openappa_policy_revisions (deployment, revision, hash)
      VALUES ('org-a', 2, ${"b".repeat(64)})
    `);

    const head = await db.execute<{ head: number; hash: string }>(sql`
      SELECT d.head, r.hash FROM openappa_deployments d
      JOIN openappa_policy_revisions r ON r.deployment = d.name AND r.revision = d.head
      WHERE d.name = 'org-a'
    `);
    expect(head.rows).toEqual([{ head: 2, hash: "b".repeat(64) }]);
  });

  test("refuses a revision naming no stored policy file or no deployment", async () => {
    await expect(
      db
        .execute(sql`
        INSERT INTO openappa_deployments (name, head) VALUES ('org-b', 1)
      `)
        .then(() =>
          db.execute(sql`
          INSERT INTO openappa_policy_revisions (deployment, revision, hash)
          VALUES ('org-b', 1, ${"c".repeat(64)})
        `),
        ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        INSERT INTO openappa_policy_revisions (deployment, revision, hash)
        VALUES ('no-such-line', 1, ${"c".repeat(64)})
      `),
    ).rejects.toThrow();
  });

  test("refuses a revision or head below one", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO openappa_deployments (name, head) VALUES ('org-c', 0)`,
      ),
    ).rejects.toThrow();
    await expect(
      publish({ deployment: "org-d", revision: 0, hash: "d".repeat(64) }),
    ).rejects.toThrow();
  });

  test("indexes the revisions a line published by policy file", async () => {
    const indexes = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'openappa_policy_revisions_key_idx'
    `);
    expect(indexes.rows.map((row) => row.indexdef)).toEqual([
      expect.stringContaining("(deployment, hash, revision)"),
    ]);
  });
});

async function publish(params: {
  deployment: string;
  revision: number;
  hash: string;
}) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO openappa_policy_files (hash, bytes) VALUES (${params.hash}, '\\x00')
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO openappa_deployments (name, head)
      VALUES (${params.deployment}, ${params.revision}) ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO openappa_policy_revisions (deployment, revision, hash)
      VALUES (${params.deployment}, ${params.revision}, ${params.hash})
    `);
  });
}
