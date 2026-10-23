import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import McpToolCallModel from "./mcp-tool-call";
import UsageStatisticsModel from "./usage-statistics";

const PAGE = { limit: 100, offset: 0 } as const;
const DAY_1 = new Date("2026-10-01T10:00:00Z");
const DAY_2 = new Date("2026-10-02T23:30:00Z");
const RANGE = "custom:2026-09-30T00:00:00.000Z_2026-10-03T00:00:00.000Z";

function toolCall(params: {
  agentId: string;
  userId?: string | null;
  name: string;
  server?: string;
  isError?: boolean;
  createdAt?: Date;
}) {
  return McpToolCallModel.create({
    agentId: params.agentId,
    mcpServerName: params.server ?? "github",
    method: "tools/call",
    toolCall: { id: randomUUID(), name: params.name, arguments: {} },
    toolResult: { content: [], isError: params.isError ?? false },
    userId: params.userId ?? null,
    authMethod: null,
    createdAt: params.createdAt ?? DAY_1,
  });
}

describe("McpToolCallModel.create outcome columns", () => {
  test("records the tool name and error status of a tools/call", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const failed = await toolCall({
      agentId: agent.id,
      name: "github__merge_pull_request",
      isError: true,
    });

    const [row] = await db
      .select()
      .from(schema.mcpToolCallsTable)
      .where(eq(schema.mcpToolCallsTable.id, failed.id));
    expect(row.toolName).toBe("github__merge_pull_request");
    expect(row.isError).toBe(true);
  });

  test("keeps an encrypted chat's tool name out of plaintext", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const created = await McpToolCallModel.create(
      {
        agentId: agent.id,
        mcpServerName: "github",
        method: "tools/call",
        toolCall: { id: "1", name: "github__create_issue", arguments: {} },
        toolResult: { content: [], isError: false },
        userId: null,
        authMethod: null,
      },
      { dek: randomBytes(32), conversationId: randomUUID() },
    );

    const [row] = await db
      .select()
      .from(schema.mcpToolCallsTable)
      .where(eq(schema.mcpToolCallsTable.id, created.id));
    expect(row.toolName).toBeNull();
    expect(row.isError).toBe(false);
  });
});

describe("UsageStatisticsModel.getMcpToolCallUsage", () => {
  test("groups calls per UTC day and tool, counting errors", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const user = await makeUser();
    await toolCall({ agentId: agent.id, userId: user.id, name: "gh__search" });
    await toolCall({
      agentId: agent.id,
      userId: user.id,
      name: "gh__search",
      isError: true,
    });
    await toolCall({
      agentId: agent.id,
      userId: user.id,
      name: "gh__merge",
      createdAt: DAY_2,
    });
    // tools/list is discovery, not a call.
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "github",
      method: "tools/list",
      toolCall: null,
      toolResult: { tools: [] },
      userId: user.id,
      authMethod: null,
      createdAt: DAY_1,
    });

    const result = await UsageStatisticsModel.getMcpToolCallUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: PAGE,
      groupBy: ["day", "toolName"],
    });

    expect(result.data).toEqual([
      { day: "2026-10-01", toolName: "gh__search", calls: 2, errors: 1 },
      { day: "2026-10-02", toolName: "gh__merge", calls: 1, errors: 0 },
    ]);
    expect(result.totals).toEqual({ calls: 3, errors: 1 });
    expect(result.pagination.total).toBe(2);
    const pastEnd = await UsageStatisticsModel.getMcpToolCallUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: { limit: 1, offset: 100 },
      groupBy: ["day", "toolName"],
    });
    expect(pastEnd.data).toEqual([]);
    expect(pastEnd.pagination.total).toBe(2);
    expect(pastEnd.totals).toEqual(result.totals);
  });

  test("reads the tool name and status of rows logged before the plaintext columns", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const legacy = await toolCall({
      agentId: agent.id,
      name: "jira__update_issue",
      isError: true,
    });
    await db
      .update(schema.mcpToolCallsTable)
      .set({ toolName: null, isError: null })
      .where(eq(schema.mcpToolCallsTable.id, legacy.id));

    const result = await UsageStatisticsModel.getMcpToolCallUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: PAGE,
      groupBy: ["toolName"],
    });

    expect(result.data).toEqual([
      { toolName: "jira__update_issue", calls: 1, errors: 1 },
    ]);
  });

  test("names people and agents, and narrows to one team or one caller", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Copilot" });
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
    const [alice, bob] = await Promise.all([
      makeUser({ name: "Alice" }),
      makeUser({ name: "Bob" }),
    ]);
    const team = await makeTeam(org.id, alice.id);
    await makeTeamMember(team.id, alice.id);

    await toolCall({ agentId: agent.id, userId: alice.id, name: "a" });
    await toolCall({ agentId: agent.id, userId: alice.id, name: "b" });
    await toolCall({ agentId: agent.id, userId: bob.id, name: "a" });
    await toolCall({ agentId: foreignAgent.id, userId: bob.id, name: "a" });

    const base = {
      timeframe: RANGE as typeof RANGE,
      organizationId: org.id,
      pagination: PAGE,
      groupBy: ["userId" as const, "agentId" as const],
    };

    const all = await UsageStatisticsModel.getMcpToolCallUsage(base);
    expect(all.data).toEqual([
      {
        userId: alice.id,
        userName: "Alice",
        agentId: agent.id,
        agentName: "Copilot",
        calls: 2,
        errors: 0,
      },
      {
        userId: bob.id,
        userName: "Bob",
        agentId: agent.id,
        agentName: "Copilot",
        calls: 1,
        errors: 0,
      },
    ]);

    const teamOnly = await UsageStatisticsModel.getMcpToolCallUsage({
      ...base,
      teamId: team.id,
    });
    expect(teamOnly.data.map((row) => row.userId)).toEqual([alice.id]);

    const ownOnly = await UsageStatisticsModel.getMcpToolCallUsage({
      ...base,
      restrictToUserId: bob.id,
    });
    expect(ownOnly.totals.calls).toBe(1);
  });
});

describe("UsageStatisticsModel.getAppUsage", () => {
  test("combines opens and tool calls with the LLM spend the app generated", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const [board, hidden] = await Promise.all([
      makeApp({ organizationId: org.id, name: "Board" }),
      makeApp({ organizationId: org.id, name: "Hidden" }),
    ]);

    for (const method of ["tools/list", "tools/list", "tools/call"]) {
      await McpToolCallModel.create({
        ownerType: "app",
        appId: board.id,
        agentId: null,
        mcpServerName: "mcp-app-gateway",
        method,
        toolCall:
          method === "tools/call"
            ? { id: "1", name: "app__save", arguments: {} }
            : null,
        toolResult: null,
        userId: null,
        authMethod: null,
        createdAt: DAY_1,
      });
    }
    await makeInteraction(agent.id, {
      appId: board.id,
      source: "app:llm_complete",
      cost: "0.2500000000",
      billingMode: "metered",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 15,
      createdAt: DAY_2,
    });
    await makeInteraction(agent.id, {
      appId: board.id,
      source: "app:llm_complete",
      inputTokens: 80,
      inputTokensEstimated: true,
      outputTokens: 5,
      createdAt: DAY_2,
    });
    await makeInteraction(agent.id, {
      appId: hidden.id,
      source: "app:llm_complete",
      cost: "9.0000000000",
      createdAt: DAY_2,
    });

    const result = await UsageStatisticsModel.getAppUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: PAGE,
      groupBy: ["day", "appId"],
      accessibleAppIds: [board.id],
    });

    expect(result.data).toEqual([
      expect.objectContaining({
        day: "2026-10-01",
        appId: board.id,
        appName: "Board",
        runs: 2,
        toolCalls: 1,
        llmRequests: 0,
      }),
      expect.objectContaining({
        day: "2026-10-02",
        appId: board.id,
        runs: 0,
        llmRequests: 2,
        inputTokens: 180,
        outputTokens: 15,
        cacheReadTokens: 40,
        cacheWriteTokens: 15,
        totalTokens: 130,
        billedCost: 0.25,
        subscriptionCost: 0,
      }),
    ]);
    const pastEnd = await UsageStatisticsModel.getAppUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: { limit: 1, offset: 100 },
      groupBy: ["day", "appId"],
      accessibleAppIds: [board.id],
    });
    expect(pastEnd.data).toEqual([]);
    expect(pastEnd.pagination.total).toBe(2);
    expect(pastEnd.totals).toEqual(result.totals);
    expect(result.totals).toMatchObject({
      runs: 2,
      toolCalls: 1,
      llmRequests: 2,
      totalTokens: 130,
      billedCost: 0.25,
    });
  });
});

describe("UsageStatisticsModel.getSkillUsage", () => {
  test("counts activations, context tokens and distinct people per day", async ({
    makeOrganization,
    makeSkill,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const skill = await makeSkill(org.id, { name: "code-review" });
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);

    await db.insert(schema.skillUsageEventsTable).values([
      {
        skillId: skill.id,
        userId: alice.id,
        contextTokens: 100,
        createdAt: DAY_1,
      },
      {
        skillId: skill.id,
        userId: alice.id,
        contextTokens: 50,
        createdAt: DAY_1,
      },
      {
        skillId: skill.id,
        userId: bob.id,
        contextTokens: null,
        createdAt: DAY_1,
      },
      {
        skillId: skill.id,
        userId: bob.id,
        contextTokens: 10,
        createdAt: DAY_2,
      },
    ]);

    const result = await UsageStatisticsModel.getSkillUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: PAGE,
      groupBy: ["day", "skillId"],
    });

    expect(result.data).toEqual([
      {
        day: "2026-10-01",
        skillId: skill.id,
        skillName: "code-review",
        activations: 3,
        contextTokens: 150,
        users: 2,
      },
      {
        day: "2026-10-02",
        skillId: skill.id,
        skillName: "code-review",
        activations: 1,
        contextTokens: 10,
        users: 1,
      },
    ]);
    const pastEnd = await UsageStatisticsModel.getSkillUsage({
      timeframe: RANGE,
      organizationId: org.id,
      pagination: { limit: 1, offset: 100 },
      groupBy: ["day", "skillId"],
    });
    expect(pastEnd.data).toEqual([]);
    expect(pastEnd.pagination.total).toBe(2);
    expect(pastEnd.totals).toEqual(result.totals);
    expect(result.totals).toEqual({
      activations: 4,
      contextTokens: 160,
      users: 2,
    });
  });
});
