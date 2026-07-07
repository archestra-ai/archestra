import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0335_remove-skill-tool-auto-mode-exclusions.sql"),
  "utf-8",
);

const STATEMENT = migrationSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .trim();

// The line filter above would also swallow a `--> statement-breakpoint`,
// silently fusing statements the migrator runs separately. This migration is
// single-statement by design; fail loudly if that ever changes.
if (migrationSql.includes("statement-breakpoint")) {
  throw new Error(
    "0335 test loader only supports a single-statement migration",
  );
}

// Frozen snapshot of the short names the migration deletes. Deliberately NOT
// imported from @archestra/shared: the SQL is a point-in-time artifact, so a
// tool added to the skill group later must not change what this migration
// does.
const SKILL_SHORT_NAMES = [
  "list_skills",
  "load_skill",
  "create_skill",
  "update_skill",
];

async function runCleanup(): Promise<void> {
  await db.execute(sql.raw(STATEMENT));
}

async function seedArchestraCatalog(): Promise<void> {
  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID,
    name: "Archestra",
    serverType: "builtin",
  });
}

async function insertBuiltInTool(name: string) {
  const [row] = await db
    .insert(schema.toolsTable)
    .values({
      name,
      parameters: {},
      catalogId: ARCHESTRA_MCP_CATALOG_ID,
      agentId: null,
    })
    .returning();
  return row;
}

// Agents are raw-inserted (not via AgentModel.create) so the create-time
// pre-fill can't add rows behind the tests' back: every exclusion row in
// these tests is inserted explicitly.
async function insertAgent(
  organizationId: string,
  overrides: Partial<typeof schema.agentsTable.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId,
      name: `Legacy Agent ${crypto.randomUUID().substring(0, 8)}`,
      agentType: "agent",
      scope: "org",
      ...overrides,
    })
    .returning();
  return row;
}

async function excludeTool(agentId: string, toolId: string): Promise<void> {
  await db.insert(schema.agentExcludedToolsTable).values({ agentId, toolId });
}

async function excludedToolIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.agentExcludedToolsTable)
    .where(eq(schema.agentExcludedToolsTable.agentId, agentId));
  return rows.map((row) => row.toolId);
}

describe("0335 migration: remove skill tools from exclusion lists", () => {
  test("deletes the skill-tool exclusion rows and keeps other exclusions", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id, { accessAllTools: true });

    for (const shortName of SKILL_SHORT_NAMES) {
      const tool = await insertBuiltInTool(`archestra__${shortName}`);
      await excludeTool(agent.id, tool.id);
    }
    const other = await insertBuiltInTool("archestra__create_agent");
    await excludeTool(agent.id, other.id);

    await runCleanup();

    expect(await excludedToolIds(agent.id)).toEqual([other.id]);
  });

  test("cleans stale rows on every agent kind, not only All-tools agents", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    // A custom-mode agent with a leftover (inert) row from a past Auto-mode
    // stint: skill tools are exempt everywhere now, so the row goes too.
    const customAgent = await insertAgent(org.id, { accessAllTools: false });
    const gateway = await insertAgent(org.id, {
      agentType: "mcp_gateway",
      accessAllTools: true,
    });

    const tool = await insertBuiltInTool("archestra__list_skills");
    await excludeTool(customAgent.id, tool.id);
    await excludeTool(gateway.id, tool.id);

    await runCleanup();

    expect(await excludedToolIds(customAgent.id)).toEqual([]);
    expect(await excludedToolIds(gateway.id)).toEqual([]);
  });

  test("matches branded prefixes, including underscores in the brand", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id, { accessAllTools: true });

    const branded = await insertBuiltInTool("acme_corp__load_skill");
    await excludeTool(agent.id, branded.id);

    await runCleanup();

    expect(await excludedToolIds(agent.id)).toEqual([]);
  });

  test("ignores same-short-name tools outside the built-in Archestra catalog", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id, { accessAllTools: true });

    const externalCatalog = await makeInternalMcpCatalog();
    const [externalTool] = await db
      .insert(schema.toolsTable)
      .values({
        name: "archestra__list_skills",
        parameters: {},
        catalogId: externalCatalog.id,
        agentId: null,
      })
      .returning();
    await excludeTool(agent.id, externalTool.id);

    await runCleanup();

    expect(await excludedToolIds(agent.id)).toEqual([externalTool.id]);
  });

  test("is a no-op on re-run", async ({ makeOrganization }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id, { accessAllTools: true });

    const skill = await insertBuiltInTool("archestra__update_skill");
    const other = await insertBuiltInTool("archestra__whoami");
    await excludeTool(agent.id, skill.id);
    await excludeTool(agent.id, other.id);

    await runCleanup();
    expect(await excludedToolIds(agent.id)).toEqual([other.id]);

    await runCleanup();
    expect(await excludedToolIds(agent.id)).toEqual([other.id]);
  });
});
