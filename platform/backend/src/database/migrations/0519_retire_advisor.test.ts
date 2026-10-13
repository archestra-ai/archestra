import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
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
  path.join(__dirname, "0519_retire_advisor.sql"),
  "utf-8",
);

describe("retired built-in upgrade", () => {
  test("removes assignments while preserving historical agents, tools, and interactions", async ({
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
      name: "Advisor",
      agentType: "agent",
    });
    const retired = await makeAgent({
      organizationId: org.id,
      name: "Retired reviewer",
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION },
    });
    // Reproduce the persisted discriminator from an older installation.
    await db.execute(
      sql`UPDATE agents SET built_in_agent_config = '{"name":"advisor-agent"}'::jsonb WHERE id = ${retired.id}`,
    );
    const oldTool = await ToolModel.findOrCreateDelegationTool(retired.id);
    const ordinaryTool = await ToolModel.findOrCreateDelegationTool(
      ordinary.id,
    );
    await AgentToolModel.create(caller.id, oldTool.id);
    await AgentToolModel.create(caller.id, ordinaryTool.id);
    await AgentExcludedSubagentModel.replaceForAgent(caller.id, [
      retired.id,
      ordinary.id,
    ]);
    const history = await InteractionModel.create({
      profileId: retired.id,
      type: "openai:chatCompletions",
      model: "test-model",
      request: { model: "test-model", messages: [] },
      response: {},
      inputTokens: 10,
      outputTokens: 5,
    });

    for (let run = 0; run < 2; run++) {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        await db.execute(sql.raw(statement));
      }
    }
    await syncBuiltInAgents();

    expect(await AgentModel.findById(retired.id)).toBeNull();
    expect(await AgentModel.findById(ordinary.id)).not.toBeNull();
    expect(await AgentToolModel.findToolIdsByAgent(caller.id)).toEqual([
      ordinaryTool.id,
    ]);
    expect(
      await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(caller.id),
    ).toEqual([ordinary.id]);
    const [retiredRow] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, retired.id));
    expect(retiredRow.deletedAt).not.toBeNull();
    expect(retiredRow.builtInAgentConfig).toBeNull();
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, oldTool.id));
    expect(tool.deletedAt).not.toBeNull();
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, history.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].profileId).toBe(retired.id);
    expect(rows[0].inputTokens).toBe(10);
    const active = await db
      .select()
      .from(schema.agentsTable)
      .where(inArray(schema.agentsTable.id, [ordinary.id, caller.id]));
    expect(active.every((row) => row.deletedAt === null)).toBe(true);
  });
});
