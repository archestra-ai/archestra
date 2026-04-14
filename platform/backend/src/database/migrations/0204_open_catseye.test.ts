import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0204_open_catseye.sql"),
  "utf-8",
);

/**
 * Run only the data-migration UPDATE/WITH statements from the migration file.
 * The schema changes (ALTER TABLE, CREATE INDEX) are already applied by PGlite.
 */
async function runDataMigrationStatements() {
  // Split on Drizzle's statement breakpoint marker, then by semicolons
  const rawStatements = migrationSql
    .split("--> statement-breakpoint")
    .flatMap((block) => block.split(";"))
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);

  const dataStatements = rawStatements.filter(
    (s) =>
      s.toUpperCase().startsWith("UPDATE") ||
      s.toUpperCase().startsWith("WITH"),
  );

  for (const statement of dataStatements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

async function insertAgent(params: {
  organizationId: string;
  name: string;
  agentType: string;
  createdAt?: Date;
}) {
  const [agent] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      name: params.name,
      agentType: params.agentType as "mcp_gateway" | "agent",
      scope: "org",
      ...(params.createdAt && { createdAt: params.createdAt }),
    })
    .returning();
  // Clear slug so we can test the migration populating it
  await db.execute(sql`UPDATE agents SET slug = NULL WHERE id = ${agent.id}`);
  return agent;
}

async function getSlug(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: schema.agentsTable.slug })
    .from(schema.agentsTable)
    .where(sql`${schema.agentsTable.id} = ${agentId}`);
  return row?.slug ?? null;
}

describe("0204 migration: mcp_gateway slug population", () => {
  test("generates slug from mcp_gateway name", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const agent = await insertAgent({
      organizationId: org.id,
      name: "My Test Gateway",
      agentType: "mcp_gateway",
    });

    await runDataMigrationStatements();

    expect(await getSlug(agent.id)).toBe("my-test-gateway");
  });

  test("does not set slug for non-mcp_gateway agents", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await insertAgent({
      organizationId: org.id,
      name: "My Internal Agent",
      agentType: "agent",
    });

    await runDataMigrationStatements();

    expect(await getSlug(agent.id)).toBeNull();
  });

  test("strips special characters and normalizes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await insertAgent({
      organizationId: org.id,
      name: "Test @#$ Gateway!",
      agentType: "mcp_gateway",
    });

    await runDataMigrationStatements();

    expect(await getSlug(agent.id)).toBe("test-gateway");
  });

  test("falls back to 'gateway' for symbol-only names", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await insertAgent({
      organizationId: org.id,
      name: "@#$%",
      agentType: "mcp_gateway",
    });

    await runDataMigrationStatements();

    expect(await getSlug(agent.id)).toBe("gateway");
  });

  test("deduplicates colliding slugs, keeping oldest clean", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const older = await insertAgent({
      organizationId: org.id,
      name: "Duplicate Gateway",
      agentType: "mcp_gateway",
      createdAt: new Date("2024-01-01"),
    });
    const newer = await insertAgent({
      organizationId: org.id,
      name: "Duplicate Gateway",
      agentType: "mcp_gateway",
      createdAt: new Date("2025-01-01"),
    });

    // Drop the unique index so the data migration can run as it would in production
    // (the migration creates the index AFTER populating and deduplicating slugs)
    await db.execute(sql`DROP INDEX IF EXISTS "agents_slug_idx"`);
    await runDataMigrationStatements();

    const olderSlug = await getSlug(older.id);
    const newerSlug = await getSlug(newer.id);

    expect(olderSlug).toBe("duplicate-gateway");
    expect(newerSlug).not.toBe(olderSlug);
    expect(newerSlug).toMatch(/^duplicate-gateway-[a-f0-9]{6}$/);
  });
});
