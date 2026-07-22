import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0332_backfill-default-archestra-tool-assignments.sql"),
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
    "0332 test loader only supports a single-statement migration",
  );
}

// Frozen snapshot of the groups the migration assigns. Deliberately NOT
// imported from @archestra/shared: the SQL is a point-in-time artifact, so a
// tool added to a group later must not change what this migration does.
const BACKFILLED_SHORT_NAMES = [
  "run_command",
  "download_file",
  "upload_file",
  "search_files",
  "read_file",
  "save_file",
  "edit_file",
  "delete_file",
  "list_skills",
  "load_skill",
  "create_skill",
  "update_skill",
  "scaffold_app",
  "refine_app",
  "edit_app",
  "set_app_tools",
  "validate_app",
  "publish_app",
  "read_app",
  "preview_app_tool",
  "get_app_diagnostics",
  "render_app",
  "list_apps",
  "delete_app",
];

async function runBackfill(): Promise<void> {
  await db.execute(sql.raw(STATEMENT));
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

async function insertAllBackfilledTools(): Promise<void> {
  await db.insert(schema.toolsTable).values(
    BACKFILLED_SHORT_NAMES.map((shortName) => ({
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

async function assignedToolIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.agentToolsTable)
    .where(eq(schema.agentToolsTable.agentId, agentId));
  return rows.map((row) => row.toolId);
}

describe("0332 migration: backfill default Archestra tool assignments", () => {
  test("assigns the sandbox/files/skills/apps groups to a pre-existing agent, ignoring other built-ins", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    await insertAllBackfilledTools();
    // A built-in outside the four groups must not be assigned.
    await insertBuiltInTool("archestra__whoami");

    await runBackfill();

    const assigned = await assignedToolIds(agent.id);
    expect(assigned).toHaveLength(BACKFILLED_SHORT_NAMES.length);

    const assignedNames = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.id, assigned));
    expect(assignedNames.map((row) => row.name).sort()).toEqual(
      BACKFILLED_SHORT_NAMES.map(
        (shortName) => `archestra__${shortName}`,
      ).sort(),
    );
  });

  test("assigns only the group tools that exist", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    // Sandbox flag was never on for this deployment: only skills tools exist.
    const listSkills = await insertBuiltInTool("archestra__list_skills");
    const loadSkill = await insertBuiltInTool("archestra__load_skill");

    await runBackfill();

    const assigned = await assignedToolIds(agent.id);
    expect(assigned.sort()).toEqual([listSkills.id, loadSkill.id].sort());
  });

  test("leaves other agent types, built-in system agents, soft-deleted agents, and Auto-mode agents untouched", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    await insertAllBackfilledTools();

    const gateway = await insertAgent(org.id, { agentType: "mcp_gateway" });
    const proxy = await insertAgent(org.id, { agentType: "llm_proxy" });
    const profile = await insertAgent(org.id, { agentType: "profile" });
    const builtIn = await insertAgent(org.id, {
      builtInAgentConfig: { name: "app-runtime-llm-agent" },
    });
    const deleted = await insertAgent(org.id, { deletedAt: new Date() });
    const autoMode = await insertAgent(org.id, { accessAllTools: true });

    await runBackfill();

    for (const agent of [gateway, proxy, profile, builtIn, deleted, autoMode]) {
      expect(await assignedToolIds(agent.id)).toHaveLength(0);
    }
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
    expect(await assignedToolIds(agent.id)).toHaveLength(2);

    await runBackfill();
    expect(await assignedToolIds(agent.id)).toHaveLength(2);
  });

  test("matches branded prefixes, including underscores in the brand", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    const branded = await insertBuiltInTool("acme_corp__run_command");

    await runBackfill();

    expect(await assignedToolIds(agent.id)).toEqual([branded.id]);
  });

  test("assigns one canonical row (the oldest) for dual-prefix duplicates", async ({
    makeOrganization,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    const legacy = await insertBuiltInTool(
      "archestra__list_skills",
      "2026-01-01T00:00:00Z",
    );
    await insertBuiltInTool("acme__list_skills", "2026-06-01T00:00:00Z");

    await runBackfill();

    expect(await assignedToolIds(agent.id)).toEqual([legacy.id]);
  });

  test("ignores same-short-name tools outside the built-in Archestra catalog", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    const agent = await insertAgent(org.id);

    const externalCatalog = await makeInternalMcpCatalog();
    await db.insert(schema.toolsTable).values({
      name: "archestra__run_command",
      parameters: {},
      catalogId: externalCatalog.id,
      agentId: null,
    });

    await runBackfill();

    expect(await assignedToolIds(agent.id)).toHaveLength(0);
  });

  test("does not touch agent_excluded_tools", async ({ makeOrganization }) => {
    await seedArchestraCatalog();
    const org = await makeOrganization();
    // A custom-mode agent with a leftover (inert) exclusion row from a past
    // Auto-mode stint: the assignment is still created, the exclusion row
    // survives untouched.
    const agent = await insertAgent(org.id);

    const runCommand = await insertBuiltInTool("archestra__run_command");
    await db
      .insert(schema.agentExcludedToolsTable)
      .values({ agentId: agent.id, toolId: runCommand.id });

    await runBackfill();

    expect(await assignedToolIds(agent.id)).toEqual([runCommand.id]);
    const exclusions = await db
      .select()
      .from(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agent.id));
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].toolId).toBe(runCommand.id);
  });
});
