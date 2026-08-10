import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0407_collapse_advisor_to_org_wide.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    // SET LOCAL is a no-op outside the migrator's transaction; the data
    // statements are what the test exercises.
    .filter(
      (statement) => statement.length > 0 && !statement.startsWith("SET"),
    );

  if (statements.length === 0) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function makeAdvisorRow(params: {
  organizationId: string;
  environmentId?: string | null;
  deletedAt?: Date | null;
  createdAt?: Date;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      name: "Advisor",
      agentType: "agent",
      scope: "org",
      systemPrompt: "advisor prompt",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
      environmentId: params.environmentId ?? null,
      deletedAt: params.deletedAt ?? null,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    })
    .returning({ id: schema.agentsTable.id });
  return row;
}

async function makeEnvironment(organizationId: string, name: string) {
  const [row] = await db
    .insert(schema.environmentsTable)
    .values({ organizationId, name })
    .returning({ id: schema.environmentsTable.id });
  return row;
}

async function makeDelegationToolRow(
  targetAgentId: string,
  createdAt?: Date,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.toolsTable)
    .values({
      name: "agent__advisor",
      delegateToAgentId: targetAgentId,
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: schema.toolsTable.id });
  return row;
}

async function grantTool(agentId: string, toolId: string) {
  await db.insert(schema.agentToolsTable).values({ agentId, toolId });
}

async function excludeSubagent(agentId: string, targetAgentId: string) {
  await db
    .insert(schema.agentExcludedSubagentsTable)
    .values({ agentId, targetAgentId });
}

async function liveAdvisorRows(organizationId: string) {
  return db
    .select({
      id: schema.agentsTable.id,
      environmentId: schema.agentsTable.environmentId,
    })
    .from(schema.agentsTable)
    .where(
      and(
        eq(schema.agentsTable.organizationId, organizationId),
        sql`${schema.agentsTable.builtInAgentConfig}->>'name' = ${BUILT_IN_AGENT_IDS.ADVISOR}`,
        isNull(schema.agentsTable.deletedAt),
      ),
    );
}

async function agentExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, id));
  return rows.length > 0;
}

async function grantedToolIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ toolId: schema.agentToolsTable.toolId })
    .from(schema.agentToolsTable)
    .where(eq(schema.agentToolsTable.agentId, agentId));
  return rows.map((r) => r.toolId);
}

async function excludedTargetIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ targetId: schema.agentExcludedSubagentsTable.targetAgentId })
    .from(schema.agentExcludedSubagentsTable)
    .where(eq(schema.agentExcludedSubagentsTable.agentId, agentId));
  return rows.map((r) => r.targetId);
}

const past = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

describe("0407 collapse advisor to org-wide", () => {
  test("collapses per-env advisors onto the org-wide row, remapping grants and exclusions", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const envA = await makeEnvironment(org.id, "env-a");
    const envB = await makeEnvironment(org.id, "env-b");

    const orgAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      createdAt: past(30),
    });
    const envAdvisorA = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envA.id,
      createdAt: past(20),
    });
    const envAdvisorB = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envB.id,
      createdAt: past(10),
    });

    const envToolA = await makeDelegationToolRow(envAdvisorA.id);
    const granted = await makeAgent({
      organizationId: org.id,
      environmentId: envA.id,
    });
    await grantTool(granted.id, envToolA.id);

    const excluder = await makeAgent({
      organizationId: org.id,
      environmentId: envB.id,
    });
    await excludeSubagent(excluder.id, envAdvisorB.id);

    await runMigration();

    const survivors = await liveAdvisorRows(org.id);
    expect(survivors).toEqual([{ id: orgAdvisor.id, environmentId: null }]);
    expect(await agentExists(envAdvisorA.id)).toBe(false);
    expect(await agentExists(envAdvisorB.id)).toBe(false);

    // The env advisor's tool was promoted to the survivor (it had none), so
    // the existing grant row now reaches the survivor without remapping.
    const [promotedTool] = await db
      .select({
        id: schema.toolsTable.id,
        delegateToAgentId: schema.toolsTable.delegateToAgentId,
      })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, envToolA.id));
    expect(promotedTool.delegateToAgentId).toBe(orgAdvisor.id);
    expect(await grantedToolIds(granted.id)).toEqual([envToolA.id]);

    expect(await excludedTargetIds(excluder.id)).toEqual([orgAdvisor.id]);
  });

  test("keeps a single grant when an agent was granted both its env advisor and the org advisor", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const env = await makeEnvironment(org.id, "env");

    const orgAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      createdAt: past(30),
    });
    const envAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: env.id,
      createdAt: past(20),
    });

    const orgTool = await makeDelegationToolRow(orgAdvisor.id, past(30));
    const envTool = await makeDelegationToolRow(envAdvisor.id, past(20));
    const agent = await makeAgent({ organizationId: org.id });
    await grantTool(agent.id, orgTool.id);
    await grantTool(agent.id, envTool.id);

    await runMigration();

    // The env tool cascades away with its advisor; only the canonical grant
    // survives, and the INSERT ... ON CONFLICT did not duplicate it.
    expect(await grantedToolIds(agent.id)).toEqual([orgTool.id]);
  });

  test("promotes the oldest per-env advisor when the org has no live org-wide row", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const envA = await makeEnvironment(org.id, "env-a");
    const envB = await makeEnvironment(org.id, "env-b");

    // Soft-deleted null-env residue (old deleteEnvironment behavior): must
    // not be chosen as survivor, must be gone afterwards.
    const residue = await makeAdvisorRow({
      organizationId: org.id,
      deletedAt: past(5),
      createdAt: past(40),
    });
    const oldest = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envA.id,
      createdAt: past(30),
    });
    const newer = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envB.id,
      createdAt: past(20),
    });

    await runMigration();

    const survivors = await liveAdvisorRows(org.id);
    expect(survivors).toEqual([{ id: oldest.id, environmentId: null }]);
    expect(await agentExists(newer.id)).toBe(false);
    expect(await agentExists(residue.id)).toBe(false);
  });

  test("keeps the survivor's own tool canonical when both it and env tools exist", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const env = await makeEnvironment(org.id, "env");

    const orgAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      createdAt: past(30),
    });
    const envAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: env.id,
      createdAt: past(20),
    });

    const orgTool = await makeDelegationToolRow(orgAdvisor.id, past(30));
    const envTool = await makeDelegationToolRow(envAdvisor.id, past(20));
    const agent = await makeAgent({
      organizationId: org.id,
      environmentId: env.id,
    });
    await grantTool(agent.id, envTool.id);

    await runMigration();

    // Grant remapped onto the survivor's existing tool; the env tool was not
    // promoted (survivor already had one) and cascaded away.
    expect(await grantedToolIds(agent.id)).toEqual([orgTool.id]);
    const envToolRows = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, envTool.id));
    expect(envToolRows).toHaveLength(0);
  });

  test("remaps interaction history to the survivor while preserving its environment snapshot", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await makeEnvironment(org.id, "env");

    const orgAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      createdAt: past(30),
    });
    const envAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: env.id,
      createdAt: past(20),
    });

    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values({
        request: {},
        response: {},
        type: "anthropic:messages",
        profileId: envAdvisor.id,
        environmentId: env.id,
      })
      .returning({ id: schema.interactionsTable.id });

    await runMigration();

    const [row] = await db
      .select({
        profileId: schema.interactionsTable.profileId,
        environmentId: schema.interactionsTable.environmentId,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(row.profileId).toBe(orgAdvisor.id);
    expect(row.environmentId).toBe(env.id);
  });

  test("leaves other organizations and non-advisor agents untouched", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const envA = await makeEnvironment(orgA.id, "env-a");

    const advisorA = await makeAdvisorRow({
      organizationId: orgA.id,
      createdAt: past(30),
    });
    const envAdvisorA = await makeAdvisorRow({
      organizationId: orgA.id,
      environmentId: envA.id,
      createdAt: past(20),
    });
    const advisorB = await makeAdvisorRow({
      organizationId: orgB.id,
      createdAt: past(30),
    });

    const regular = await makeAgent({
      organizationId: orgA.id,
      environmentId: envA.id,
      name: "Regular env agent",
    });
    const regularTool = await makeDelegationToolRow(regular.id);
    const caller = await makeAgent({ organizationId: orgA.id });
    await grantTool(caller.id, regularTool.id);
    await excludeSubagent(caller.id, regular.id);

    await runMigration();

    expect(await liveAdvisorRows(orgA.id)).toEqual([
      { id: advisorA.id, environmentId: null },
    ]);
    expect(await liveAdvisorRows(orgB.id)).toEqual([
      { id: advisorB.id, environmentId: null },
    ]);
    expect(await agentExists(envAdvisorA.id)).toBe(false);

    // Non-advisor delegation state is untouched, env scoping included.
    expect(await agentExists(regular.id)).toBe(true);
    expect(await grantedToolIds(caller.id)).toEqual([regularTool.id]);
    expect(await excludedTargetIds(caller.id)).toEqual([regular.id]);
  });
});
