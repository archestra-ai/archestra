import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(
    __dirname,
    "0336_backfill-sandbox-and-auto-mode-tool-assignments.sql",
  ),
  "utf-8",
);

// Two INSERT statements split on the breakpoint, comment lines stripped —
// same loader as the 0330 test.
const STATEMENTS = migrationSql
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((chunk) => chunk.length > 0);

if (STATEMENTS.length !== 2) {
  throw new Error("0336 test loader expects exactly two statements");
}

// Frozen snapshots of the groups the migration assigns. Deliberately NOT
// imported from @archestra/shared: the SQL is a point-in-time artifact, so a
// tool added to a group later must not change what this migration does.
const SANDBOX_SHORT_NAMES = [
  "run_command",
  "download_file",
  "upload_file",
  "search_files",
  "read_file",
  "save_file",
  "edit_file",
  "delete_file",
];
const SKILL_SHORT_NAMES = [
  "list_skills",
  "load_skill",
  "create_skill",
  "update_skill",
];

async function runBackfill(): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

async function seedArchestraCatalog(): Promise<void> {
  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID,
    name: "Archestra",
    serverType: "builtin",
  });
}

async function insertBuiltInTool(name: string, createdAt?: string) {
  const [row] = await db
    .insert(schema.toolsTable)
    .values({
      name,
      parameters: {},
      catalogId: ARCHESTRA_MCP_CATALOG_ID,
      agentId: null,
      ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
    })
    .returning();
  return row;
}

async function insertAllGroupTools(): Promise<void> {
  await db.insert(schema.toolsTable).values(
    [...SANDBOX_SHORT_NAMES, ...SKILL_SHORT_NAMES].map((shortName) => ({
      name: `archestra__${shortName}`,
      parameters: {},
      catalogId: ARCHESTRA_MCP_CATALOG_ID,
      agentId: null,
    })),
  );
}

// Agents are raw-inserted (not via AgentModel.create) so the create-time
// assign hooks can't pre-assign anything: these tests pin the SQL's own
// behavior against agents that predate the hooks.
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

async function assignedShortNames(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.toolsTable.name })
    .from(schema.agentToolsTable)
    .innerJoin(
      schema.toolsTable,
      eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
    )
    .where(eq(schema.agentToolsTable.agentId, agentId));
  return rows.map((row) => row.name.replace(/^.*__/, "")).sort();
}

describe("0336 migration: backfill sandbox and All-tools-mode assignments", () => {
  test("assigns sandbox/files to every agent kind and both modes; skill tools to All-tools agents only", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    await insertAllGroupTools();
    const org = await makeOrganization();

    const customAgent = await insertAgent(org.id);
    const allToolsAgent = await insertAgent(org.id, { accessAllTools: true });
    const gateway = await insertAgent(org.id, {
      agentType: "mcp_gateway",
      accessAllTools: true,
    });
    const proxy = await insertAgent(org.id, { agentType: "llm_proxy" });

    await runBackfill();

    expect(await assignedShortNames(customAgent.id)).toEqual(
      [...SANDBOX_SHORT_NAMES].sort(),
    );
    expect(await assignedShortNames(proxy.id)).toEqual(
      [...SANDBOX_SHORT_NAMES].sort(),
    );
    for (const agent of [allToolsAgent, gateway]) {
      expect(await assignedShortNames(agent.id)).toEqual(
        [...SANDBOX_SHORT_NAMES, ...SKILL_SHORT_NAMES].sort(),
      );
    }
  });

  test("skips built-in system agents and soft-deleted agents", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    await insertAllGroupTools();
    const org = await makeOrganization();

    const builtIn = await insertAgent(org.id, {
      accessAllTools: true,
      builtInAgentConfig: { name: "app-runtime-llm-agent" },
    });
    const deleted = await insertAgent(org.id, {
      accessAllTools: true,
      deletedAt: new Date(),
    });

    await runBackfill();

    expect(await assignedShortNames(builtIn.id)).toEqual([]);
    expect(await assignedShortNames(deleted.id)).toEqual([]);
  });

  test("assigns only the group tools that exist", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const allToolsAgent = await insertAgent(org.id, { accessAllTools: true });

    // Runtime never enabled: no sandbox rows, only the always-seeded skills.
    await insertBuiltInTool("archestra__list_skills");
    await insertBuiltInTool("archestra__load_skill");

    await runBackfill();

    expect(await assignedShortNames(allToolsAgent.id)).toEqual([
      "list_skills",
      "load_skill",
    ]);
  });

  test("keeps existing assignments and is a no-op on re-run", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    const runCommand = await insertBuiltInTool("archestra__run_command");
    await insertBuiltInTool("archestra__upload_file");
    await db
      .insert(schema.agentToolsTable)
      .values({ agentId: agent.id, toolId: runCommand.id });

    await runBackfill();
    expect(await assignedShortNames(agent.id)).toEqual([
      "run_command",
      "upload_file",
    ]);

    await runBackfill();
    expect(await assignedShortNames(agent.id)).toEqual([
      "run_command",
      "upload_file",
    ]);
  });

  test("matches branded prefixes and assigns one canonical row for dual-prefix duplicates", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    const legacy = await insertBuiltInTool(
      "archestra__run_command",
      "2026-01-01T00:00:00Z",
    );
    await insertBuiltInTool("acme_corp__run_command", "2026-06-01T00:00:00Z");

    await runBackfill();

    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(rows.map((row) => row.toolId)).toEqual([legacy.id]);
  });

  test("ignores same-short-name tools outside the built-in Archestra catalog", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id, { accessAllTools: true });

    const externalCatalog = await makeInternalMcpCatalog();
    await db.insert(schema.toolsTable).values(
      ["run_command", "list_skills"].map((shortName) => ({
        name: `archestra__${shortName}`,
        parameters: {},
        catalogId: externalCatalog.id,
        agentId: null,
      })),
    );

    await runBackfill();

    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(inArray(schema.agentToolsTable.agentId, [agent.id]));
    expect(rows).toHaveLength(0);
  });
});
