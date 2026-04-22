import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0216_eager_steel_serpent.sql"),
  "utf-8",
);

/**
 * Run only the data-migration UPDATE and DELETE statements from the migration
 * file. The schema changes (ALTER TABLE, CREATE INDEX, FK constraints) are
 * already applied by PGlite at test startup, so here we re-run the parts that
 * operate on row data after we reset `organization_id` to NULL.
 */
async function runDataMigrationStatements() {
  const rawStatements = migrationSql
    .split("--> statement-breakpoint")
    .flatMap((block) => block.split(";"))
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);

  const dataStatements = rawStatements.filter((s) => {
    const upper = s.toUpperCase();
    return upper.startsWith("UPDATE") || upper.startsWith("DELETE FROM");
  });

  for (const statement of dataStatements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

async function clearOrganizationIds() {
  // Drop NOT NULL so we can blank the values for the test, then we re-fill
  // them via the backfill statements we want to exercise.
  await db.execute(
    sql`ALTER TABLE "limits" ALTER COLUMN "organization_id" DROP NOT NULL`,
  );
  await db.execute(sql`UPDATE "limits" SET "organization_id" = NULL`);
}

async function getOrganizationId(limitId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: schema.limitsTable.organizationId })
    .from(schema.limitsTable)
    .where(eq(schema.limitsTable.id, limitId));
  return row?.organizationId ?? null;
}

async function limitExists(limitId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.limitsTable.id })
    .from(schema.limitsTable)
    .where(eq(schema.limitsTable.id, limitId));
  return !!row;
}

async function insertLimit(params: {
  entityType: "organization" | "team" | "agent";
  entityId: string;
  organizationId: string;
}) {
  const [limit] = await db
    .insert(schema.limitsTable)
    .values({
      entityType: params.entityType,
      entityId: params.entityId,
      organizationId: params.organizationId,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    })
    .returning();
  return limit;
}

describe("0213 migration: limits.organization_id backfill", () => {
  test("organization-scope limits backfill from entity_id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const limit = await insertLimit({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await getOrganizationId(limit.id)).toBe(org.id);
  });

  test("team-scope limits backfill via the team row", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const limit = await insertLimit({
      entityType: "team",
      entityId: team.id,
      organizationId: org.id,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await getOrganizationId(limit.id)).toBe(org.id);
  });

  test("agent-scope limits backfill via the agent row", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Agent for limit backfill" });
    const limit = await insertLimit({
      entityType: "agent",
      entityId: agent.id,
      organizationId: agent.organizationId,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await getOrganizationId(limit.id)).toBe(agent.organizationId);
  });

  test("orphan team-scope limits are deleted", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const orphan = await insertLimit({
      entityType: "team",
      entityId: "deleted-team-id",
      organizationId: org.id,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await limitExists(orphan.id)).toBe(false);
  });

  test("orphan agent-scope limits are deleted (exercises uuid::text cast)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    // Valid-looking uuid that does not correspond to any row in the agents table.
    const orphan = await insertLimit({
      entityType: "agent",
      entityId: "00000000-0000-0000-0000-000000000000",
      organizationId: org.id,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await limitExists(orphan.id)).toBe(false);
  });

  test("keeps org/team/agent limits side by side", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      name: "Mixed backfill agent",
      organizationId: org.id,
    });

    const orgLimit = await insertLimit({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
    });
    const teamLimit = await insertLimit({
      entityType: "team",
      entityId: team.id,
      organizationId: org.id,
    });
    const agentLimit = await insertLimit({
      entityType: "agent",
      entityId: agent.id,
      organizationId: agent.organizationId,
    });

    await clearOrganizationIds();
    await runDataMigrationStatements();

    expect(await getOrganizationId(orgLimit.id)).toBe(org.id);
    expect(await getOrganizationId(teamLimit.id)).toBe(org.id);
    expect(await getOrganizationId(agentLimit.id)).toBe(agent.organizationId);
  });
});
