import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { syncBuiltInAgents } from "@/database/seed";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentToolModel,
  InteractionModel,
  ToolModel,
} from "@/models";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0524_pale_mikhail_rasputin.sql"),
  "utf-8",
);

// The test database is already migrated, so the table and column drops have
// run; replay only the data statements, twice, to prove they are idempotent.
const dataStatements = migrationSql
  .split("--> statement-breakpoint")
  .filter((statement) => /^\s*(UPDATE|DELETE)\b/m.test(statement));

async function runDataStatements() {
  for (let run = 0; run < 2; run++) {
    for (const statement of dataStatements) {
      await db.execute(sql.raw(statement));
    }
  }
}

async function permissions(id: string) {
  const [role] = await db
    .select()
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission);
}

describe("legacy guardrails removal", () => {
  test("custom roles drop toolPolicy and keep everything else", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const withToolPolicy = await makeCustomRole(org.id, {
      permission: { agent: ["read"], toolPolicy: ["read", "update"] },
    });
    const without = await makeCustomRole(org.id, {
      permission: { agent: ["read", "create"] },
    });

    await runDataStatements();

    expect(await permissions(withToolPolicy.id)).toEqual({ agent: ["read"] });
    expect(await permissions(without.id)).toEqual({
      agent: ["read", "create"],
    });
  });

  test("retires the legacy built-ins while preserving their history", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const caller = await makeAgent({
      organizationId: org.id,
      name: "Caller",
      agentType: "agent",
    });
    const ordinary = await makeAgent({
      organizationId: org.id,
      name: "Ordinary",
      agentType: "agent",
    });
    const retiredIds: string[] = [];
    const retiredToolIds: string[] = [];
    for (const legacyName of [
      "policy-configuration-subagent",
      "dual-llm-main-agent",
      "dual-llm-quarantine-agent",
    ]) {
      const retired = await makeAgent({
        organizationId: org.id,
        name: legacyName,
        agentType: "agent",
      });
      // Reproduce the persisted discriminator from an older installation.
      await db.execute(
        sql`UPDATE agents SET built_in_agent_config = ${JSON.stringify({ name: legacyName })}::jsonb WHERE id = ${retired.id}`,
      );
      const tool = await ToolModel.findOrCreateDelegationTool(retired.id);
      await AgentToolModel.create(caller.id, tool.id);
      retiredIds.push(retired.id);
      retiredToolIds.push(tool.id);
    }
    const ordinaryTool = await ToolModel.findOrCreateDelegationTool(
      ordinary.id,
    );
    await AgentToolModel.create(caller.id, ordinaryTool.id);
    await AgentExcludedSubagentModel.replaceForAgent(caller.id, [
      ...retiredIds,
      ordinary.id,
    ]);
    const history = await InteractionModel.create({
      profileId: retiredIds[0],
      type: "openai:chatCompletions",
      model: "test-model",
      request: { model: "test-model", messages: [] },
      response: {},
      inputTokens: 10,
      outputTokens: 5,
    });

    await runDataStatements();
    await syncBuiltInAgents();

    for (const id of retiredIds) {
      expect(await AgentModel.findById(id)).toBeNull();
    }
    expect(await AgentModel.findById(ordinary.id)).not.toBeNull();
    expect(await AgentToolModel.findToolIdsByAgent(caller.id)).toEqual([
      ordinaryTool.id,
    ]);
    expect(
      await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(caller.id),
    ).toEqual([ordinary.id]);

    const retiredRows = await db
      .select()
      .from(schema.agentsTable)
      .where(inArray(schema.agentsTable.id, retiredIds));
    expect(retiredRows).toHaveLength(3);
    for (const row of retiredRows) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.builtInAgentConfig).toBeNull();
    }
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.id, retiredToolIds));
    expect(tools.every((tool) => tool.deletedAt !== null)).toBe(true);

    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, history.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].profileId).toBe(retiredIds[0]);
  });
});
