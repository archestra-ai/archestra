import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0330_auto_mode_tool_exclusions.sql"),
  "utf-8",
);

// The migration's DDL (CREATE TABLE / ADD CONSTRAINT) is already applied to the
// test database by the migration runner, so exercise only the data backfill —
// the INSERT statements — split on the breakpoint with comment lines stripped.
const STATEMENTS = migrationSql
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((chunk) => /^INSERT\b/i.test(chunk));

async function runBackfill(): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

async function seedBuiltinCatalog(): Promise<void> {
  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID,
    name: "Archestra",
    serverType: "builtin",
  });
}

async function insertBuiltinTool(name: string) {
  const [tool] = await db
    .insert(schema.toolsTable)
    .values({
      name,
      parameters: {},
      catalogId: ARCHESTRA_MCP_CATALOG_ID,
      agentId: null,
    })
    .returning();
  return tool;
}

async function setAccessAllTools(agentId: string, value: boolean) {
  await db
    .update(schema.agentsTable)
    .set({ accessAllTools: value })
    .where(eq(schema.agentsTable.id, agentId));
}

async function listExclusions(agentId: string) {
  return db
    .select()
    .from(schema.agentExcludedToolsTable)
    .where(eq(schema.agentExcludedToolsTable.agentId, agentId));
}

describe("0330 migration: backfill agent_excluded_tools for All-tools agents", () => {
  test("excludes unassigned built-ins but keeps assigned ones visible", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    const assigned = await insertBuiltinTool("archestra__whoami");
    const unassigned = await insertBuiltinTool("archestra__list_agents");

    const agent = await makeAgent();
    await setAccessAllTools(agent.id, true);
    await db
      .insert(schema.agentToolsTable)
      .values({ agentId: agent.id, toolId: assigned.id });

    await runBackfill();

    const exclusions = await listExclusions(agent.id);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].toolId).toBe(unassigned.id);
  });

  test("never excludes the always-available short names, even unassigned", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    await insertBuiltinTool("archestra__run_command");
    await insertBuiltinTool("archestra__query_knowledge_sources");
    await insertBuiltinTool("archestra__search_tools");
    const excludable = await insertBuiltinTool("archestra__whoami");

    const agent = await makeAgent();
    await setAccessAllTools(agent.id, true);

    await runBackfill();

    const exclusions = await listExclusions(agent.id);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].toolId).toBe(excludable.id);
  });

  test("writes nothing for Custom-mode agents (access_all_tools = false)", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    await insertBuiltinTool("archestra__whoami");
    await insertBuiltinTool("archestra__list_agents");

    const agent = await makeAgent();
    // makeAgent defaults leave access_all_tools at its column default (false).

    await runBackfill();

    expect(await listExclusions(agent.id)).toHaveLength(0);
  });

  test("preserves a pre-existing exclusion row without duplicating it", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    const tool = await insertBuiltinTool("archestra__whoami");

    const agent = await makeAgent();
    await setAccessAllTools(agent.id, true);
    const [existing] = await db
      .insert(schema.agentExcludedToolsTable)
      .values({
        agentId: agent.id,
        toolId: tool.id,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();

    await runBackfill();

    const exclusions = await listExclusions(agent.id);
    expect(exclusions).toHaveLength(1);
    // ON CONFLICT DO NOTHING kept the original row (created_at unchanged).
    expect(exclusions[0].createdAt).toEqual(existing.createdAt);
  });

  test("is idempotent: running the migration twice changes nothing", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    await insertBuiltinTool("archestra__whoami");
    await insertBuiltinTool("archestra__list_agents");

    const agent = await makeAgent();
    await setAccessAllTools(agent.id, true);

    await runBackfill();
    const firstRun = await listExclusions(agent.id);
    expect(firstRun).toHaveLength(2);

    await runBackfill();
    const secondRun = await listExclusions(agent.id);
    expect(secondRun).toHaveLength(2);
    expect(new Set(secondRun.map((row) => row.toolId))).toEqual(
      new Set(firstRun.map((row) => row.toolId)),
    );
  });

  test("matches branded prefixes by short name, both directions", async ({
    makeAgent,
  }) => {
    await seedBuiltinCatalog();
    // Branded management built-in: excluded via the short-name suffix rule.
    const brandedWhoami = await insertBuiltinTool("acme_corp__whoami");
    // Branded exempt built-in: the suffix rule must also protect it.
    await insertBuiltinTool("acme_corp__run_command");

    const agent = await makeAgent();
    await setAccessAllTools(agent.id, true);

    await runBackfill();

    const exclusions = await listExclusions(agent.id);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].toolId).toBe(brandedWhoami.id);
  });
});
