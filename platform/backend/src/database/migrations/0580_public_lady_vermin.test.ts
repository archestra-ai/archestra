import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";

const statements = fs
  .readFileSync(path.join(__dirname, "0580_public_lady_vermin.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

// What a rollback to the previous release re-creates before that release
// starts: the statements the release notes give, and migration 0550's table.
const ROLLBACK = [
  `ALTER TABLE "guardrails_deployment" ADD COLUMN "new_session_policy" varchar(16) DEFAULT 'live' NOT NULL`,
  `ALTER TABLE "openappa_effective_policies" ADD COLUMN "retained_annotators" jsonb`,
  ...fs
    .readFileSync(path.join(__dirname, "0550_lethal_joshua_kane.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("openappa_root_openings")),
];

describe("0580 drops the policy-snapshot schema", () => {
  test("a fresh install has no setting for new sessions, no retained annotators and no root openings", async () => {
    expect(await present()).toEqual({
      newSessionPolicy: false,
      retainedAnnotators: false,
      rootOpenings: false,
    });
  });

  test("an upgrade drops the three objects and keeps the rows around them", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    for (const statement of ROLLBACK) await db.execute(sql.raw(statement));
    expect(await present()).toEqual({
      newSessionPolicy: true,
      retainedAnnotators: true,
      rootOpenings: true,
    });
    await db.execute(sql`
      INSERT INTO guardrails_deployment (id, enabled, new_session_policy)
      VALUES ('global', true, 'snapshot')
    `);
    await db.execute(sql`
      INSERT INTO openappa_effective_policies
        (organization_id, content, content_hash, root_revision, install_fingerprint, compiled_at, retained_annotators)
      VALUES (${organization.id}, '[policy]', ${"a".repeat(64)}, 3, 'v10:fingerprint', now(), '{"v":1}'::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO openappa_root_openings (root, organization_id, policy_file_key)
      VALUES ('archestra:root', ${organization.id}, ${"b".repeat(64)})
    `);

    for (const statement of statements) await db.execute(sql.raw(statement));

    expect(await present()).toEqual({
      newSessionPolicy: false,
      retainedAnnotators: false,
      rootOpenings: false,
    });
    expect(
      (
        await db.execute<{ id: string; enabled: boolean }>(
          sql`SELECT id, enabled FROM guardrails_deployment`,
        )
      ).rows,
    ).toEqual([{ id: "global", enabled: true }]);
    expect(
      (
        await db.execute<{ root_revision: number }>(
          sql`SELECT root_revision FROM openappa_effective_policies WHERE organization_id = ${organization.id}`,
        )
      ).rows,
    ).toEqual([{ root_revision: 3 }]);
  });
});

async function present() {
  const column = async (table: string, name: string) =>
    (
      await db.execute(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${name}
      `)
    ).rows.length > 0;
  return {
    newSessionPolicy: await column(
      "guardrails_deployment",
      "new_session_policy",
    ),
    retainedAnnotators: await column(
      "openappa_effective_policies",
      "retained_annotators",
    ),
    rootOpenings:
      (
        await db.execute(sql`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'openappa_root_openings'
        `)
      ).rows.length > 0,
  };
}
