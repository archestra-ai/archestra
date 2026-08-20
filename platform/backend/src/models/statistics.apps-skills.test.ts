import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InsertSkill } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import McpToolCallModel from "./mcp-tool-call";
import SkillModel from "./skill";
import StatisticsModel from "./statistics";

const PAGE = { limit: 20, offset: 0 } as const;

function skillInput(overrides: Partial<InsertSkill>): InsertSkill {
  return {
    organizationId: "org",
    authorId: null,
    name: "skill",
    description: "desc",
    content: "# body",
    metadata: {},
    sourceType: "manual",
    scope: "org" as ResourceVisibilityScope,
    ...overrides,
  };
}

/**
 * `recordUsage` is fire-and-forget background work, so a test that reads the
 * events back has to let the insert land first.
 */
async function seedActivation(params: {
  skillId: string;
  userId: string | null;
  sessionId?: string | null;
  contextTokens?: number | null;
  createdAt?: Date;
}) {
  await db.insert(schema.skillUsageEventsTable).values({
    skillId: params.skillId,
    userId: params.userId,
    sessionId: params.sessionId ?? null,
    contextTokens: params.contextTokens ?? null,
    createdAt: params.createdAt ?? new Date(),
  });
}

describe("StatisticsModel.getAppStatistics", () => {
  test("reports the authoring session's spend as the app's build cost", async ({
    makeOrganization,
    makeUser,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const app = await makeApp({
      organizationId: org.id,
      authorId: author.id,
      name: "Sales Dashboard",
      authoringSessionId: "conversation-1",
    });

    // Two authoring turns in the app's build session, plus an unrelated
    // session's turn that must not be counted.
    await makeInteraction(agent.id, {
      sessionId: "conversation-1",
      source: "chat",
      cost: "0.2000000000",
      inputTokens: 1_000,
      outputTokens: 100,
    });
    await makeInteraction(agent.id, {
      sessionId: "conversation-1",
      source: "chat",
      cost: "0.3000000000",
      inputTokens: 2_000,
      outputTokens: 200,
    });
    await makeInteraction(agent.id, {
      sessionId: "some-other-conversation",
      source: "chat",
      cost: "9.0000000000",
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.appId === app.id);
    expect(row).toBeDefined();
    expect(row?.buildCost).toBeCloseTo(0.5, 10);
    expect(row?.buildRequests).toBe(2);
    expect(row?.buildInputTokens).toBe(3_000);
    expect(row?.buildOutputTokens).toBe(300);
    expect(row?.hasBuildSession).toBe(true);
    expect(row?.buildSessionAppCount).toBe(1);
    expect(row?.authorName).toBe(author.name);
  });

  test("attributes app runtime LLM spend to the app that made the call", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const [appA, appB] = await Promise.all([
      makeApp({ organizationId: org.id, name: "Runtime A" }),
      makeApp({ organizationId: org.id, name: "Runtime B" }),
    ]);

    await makeInteraction(agent.id, {
      appId: appA.id,
      source: "app:llm_complete",
      cost: "0.0400000000",
      inputTokens: 40,
      outputTokens: 4,
    });
    await makeInteraction(agent.id, {
      appId: appA.id,
      source: "app:llm_complete",
      cost: "0.0100000000",
    });
    await makeInteraction(agent.id, {
      appId: appB.id,
      source: "app:llm_complete",
      cost: "1.0000000000",
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "runtimeCost",
      sortDirection: "desc",
    });

    const a = result.data.find((entry) => entry.appId === appA.id);
    const b = result.data.find((entry) => entry.appId === appB.id);
    expect(a?.runtimeCost).toBeCloseTo(0.05, 10);
    expect(a?.runtimeLlmRequests).toBe(2);
    expect(b?.runtimeCost).toBeCloseTo(1, 10);
    // Sorted by runtime cost, the heavier app comes first.
    expect(result.data[0]?.appId).toBe(appB.id);
  });

  test("counts opens and tool calls from the app runtime log", async ({
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const app = await makeApp({ organizationId: org.id, name: "Counted" });

    await McpToolCallModel.create({
      ownerType: "app",
      appId: app.id,
      agentId: null,
      mcpServerName: "mcp-app-gateway",
      method: "tools/list",
      toolCall: null,
      toolResult: null,
      userId: null,
      authMethod: null,
    });
    await McpToolCallModel.create({
      ownerType: "app",
      appId: app.id,
      agentId: null,
      mcpServerName: "mcp-app-gateway",
      method: "tools/call",
      toolCall: { id: "1", name: "app__x", arguments: {} },
      toolResult: null,
      userId: null,
      authMethod: null,
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "runs",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.appId === app.id);
    expect(row?.runs).toBe(1);
    expect(row?.toolCalls).toBe(1);
  });

  test("discloses a build session shared between apps instead of splitting its cost", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const [first, second] = await Promise.all([
      makeApp({
        organizationId: org.id,
        name: "First",
        authoringSessionId: "shared-session",
      }),
      makeApp({
        organizationId: org.id,
        name: "Second",
        authoringSessionId: "shared-session",
      }),
    ]);
    await makeInteraction(agent.id, {
      sessionId: "shared-session",
      source: "chat",
      cost: "1.0000000000",
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    for (const appId of [first.id, second.id]) {
      const row = result.data.find((entry) => entry.appId === appId);
      // Each reports the whole session's spend, and says it is shared.
      expect(row?.buildCost).toBeCloseTo(1, 10);
      expect(row?.buildSessionAppCount).toBe(2);
    }
  });

  test("reports no build session for an app created outside a chat", async ({
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const app = await makeApp({ organizationId: org.id, name: "From the UI" });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.appId === app.id);
    expect(row?.hasBuildSession).toBe(false);
    expect(row?.buildCost).toBe(0);
    expect(row?.buildSessionAppCount).toBe(0);
  });

  test("estimates chat-equivalent cost from the measured chat baseline", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const app = await makeApp({
      organizationId: org.id,
      name: "Replaces chat",
    });

    // Two chat sessions costing $1 and $3 → a $2 average per session.
    await makeInteraction(agent.id, {
      sessionId: "chat-a",
      source: "chat",
      cost: "1.0000000000",
    });
    await makeInteraction(agent.id, {
      sessionId: "chat-b",
      source: "chat",
      cost: "3.0000000000",
    });
    // API traffic is not in-product chat, so it must not move the baseline.
    await makeInteraction(agent.id, {
      sessionId: "api-session",
      source: "api",
      cost: "100.0000000000",
    });

    // Three opens of the app.
    for (let i = 0; i < 3; i += 1) {
      await McpToolCallModel.create({
        ownerType: "app",
        appId: app.id,
        agentId: null,
        mcpServerName: "mcp-app-gateway",
        method: "tools/list",
        toolCall: null,
        toolResult: null,
        userId: null,
        authMethod: null,
      });
    }

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "estimatedNetSavings",
      sortDirection: "desc",
    });

    expect(result.chatBaselineSessions).toBe(2);
    expect(result.chatBaselineCostPerSession).toBeCloseTo(2, 10);
    const row = result.data.find((entry) => entry.appId === app.id);
    expect(row?.estimatedChatEquivalentCost).toBeCloseTo(6, 10);
    // Nothing was spent building or running it, so all of it is net.
    expect(row?.estimatedNetSavings).toBeCloseTo(6, 10);
  });

  test("excludes subscription-covered spend from build and runtime cost", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const app = await makeApp({
      organizationId: org.id,
      name: "Subscription built",
      authoringSessionId: "sub-session",
    });
    await makeInteraction(agent.id, {
      sessionId: "sub-session",
      source: "chat",
      cost: "5.0000000000",
      billingMode: "subscription",
    });
    await makeInteraction(agent.id, {
      appId: app.id,
      source: "app:llm_complete",
      cost: "7.0000000000",
      billingMode: "subscription",
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.appId === app.id);
    // Flat-rate traffic incurs no per-token charge, so billed spend is zero
    // while the requests are still counted.
    expect(row?.buildCost).toBe(0);
    expect(row?.runtimeCost).toBe(0);
    expect(row?.buildRequests).toBe(1);
    expect(row?.runtimeLlmRequests).toBe(1);
  });

  test("omits apps outside the caller's visibility", async ({
    makeOrganization,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const visible = await makeApp({ organizationId: org.id, name: "Visible" });
    const hidden = await makeApp({ organizationId: org.id, name: "Hidden" });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
      accessibleAppIds: [visible.id],
    });

    expect(result.data.map((entry) => entry.appId)).toEqual([visible.id]);
    expect(result.data.map((entry) => entry.appId)).not.toContain(hidden.id);
  });

  test("ignores another organization's spend on a colliding session id", async ({
    makeOrganization,
    makeApp,
    makeAgent,
    makeInteraction,
  }) => {
    const [org, otherOrg] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
    const app = await makeApp({
      organizationId: org.id,
      name: "Own build",
      authoringSessionId: "shared-id",
    });

    await makeInteraction(agent.id, {
      sessionId: "shared-id",
      source: "chat",
      cost: "0.3000000000",
    });
    // A session id is caller-chosen (X-Archestra-Session-Id), so another
    // tenant reusing this one must not land in this app's build cost.
    await makeInteraction(foreignAgent.id, {
      sessionId: "shared-id",
      source: "chat",
      cost: "50.0000000000",
    });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.appId === app.id);
    expect(row?.buildCost).toBeCloseTo(0.3, 10);
    expect(row?.buildRequests).toBe(1);
    // The baseline averages this organization's chat sessions only.
    expect(result.chatBaselineSessions).toBe(1);
    expect(result.chatBaselineCostPerSession).toBeCloseTo(0.3, 10);
  });

  test("omits apps of another organization", async ({
    makeOrganization,
    makeApp,
  }) => {
    const [org, otherOrg] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    await makeApp({ organizationId: otherOrg.id, name: "Foreign" });

    const result = await StatisticsModel.getAppStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "totalCost",
      sortDirection: "desc",
    });

    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});

describe("StatisticsModel.getSkillStatistics", () => {
  test("sums the context tokens the skill's activations injected", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "measured" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "s1",
      contextTokens: 1_200,
    });
    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "s2",
      contextTokens: 800,
    });
    // An unmeasured activation still counts as an activation, but adds no tokens.
    await seedActivation({
      skillId: skill.id,
      userId: null,
      sessionId: "s3",
      contextTokens: null,
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "contextTokens",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.skillId === skill.id);
    expect(row?.activations).toBe(3);
    expect(row?.contextTokens).toBe(2_000);
    expect(row?.measuredActivations).toBe(2);
    expect(row?.distinctUsers).toBe(1);
  });

  test("attributes only the turns at or after the activation in its session", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "attributed" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const before = new Date(Date.now() - 60_000);
    const activatedAt = new Date(Date.now() - 30_000);
    const after = new Date(Date.now() - 10_000);

    // A turn before the skill was activated did not carry it.
    await makeInteraction(agent.id, {
      sessionId: "session-x",
      source: "chat",
      cost: "5.0000000000",
      createdAt: before,
    });
    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "session-x",
      contextTokens: 100,
      createdAt: activatedAt,
    });
    await makeInteraction(agent.id, {
      sessionId: "session-x",
      source: "chat",
      cost: "0.7000000000",
      inputTokens: 500,
      outputTokens: 50,
      createdAt: after,
    });
    // Another session entirely.
    await makeInteraction(agent.id, {
      sessionId: "session-y",
      source: "chat",
      cost: "4.0000000000",
      createdAt: after,
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "contextTokens",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.skillId === skill.id);
    expect(row?.attributedSessions).toBe(1);
    expect(row?.attributedRequests).toBe(1);
    expect(row?.attributedCost).toBeCloseTo(0.7, 10);
    expect(row?.attributedInputTokens).toBe(500);
    expect(row?.attributedOutputTokens).toBe(50);
  });

  test("counts a session's turns once when a skill is activated in it repeatedly", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "repeated" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const firstActivation = new Date(Date.now() - 60_000);
    const secondActivation = new Date(Date.now() - 40_000);
    const turnAt = new Date(Date.now() - 20_000);

    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "repeat-session",
      contextTokens: 10,
      createdAt: firstActivation,
    });
    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "repeat-session",
      contextTokens: 10,
      createdAt: secondActivation,
    });
    await makeInteraction(agent.id, {
      sessionId: "repeat-session",
      source: "chat",
      cost: "1.0000000000",
      createdAt: turnAt,
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "contextTokens",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.skillId === skill.id);
    expect(row?.activations).toBe(2);
    // The turn is attributed once, not once per activation.
    expect(row?.attributedRequests).toBe(1);
    expect(row?.attributedCost).toBeCloseTo(1, 10);
  });

  test("reports an activation with no session as costing nothing attributable", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "sessionless" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: null,
      contextTokens: 300,
    });
    await makeInteraction(agent.id, {
      sessionId: "unrelated",
      source: "chat",
      cost: "2.0000000000",
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "contextTokens",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.skillId === skill.id);
    expect(row?.contextTokens).toBe(300);
    expect(row?.attributedSessions).toBe(0);
    expect(row?.attributedCost).toBe(0);
  });

  test("ignores another organization's turns in a colliding session id", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInteraction,
  }) => {
    const [org, otherOrg] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "scoped" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const activatedAt = new Date(Date.now() - 60_000);
    const turnAt = new Date(Date.now() - 30_000);
    await seedActivation({
      skillId: skill.id,
      userId: user.id,
      sessionId: "collide",
      contextTokens: 10,
      createdAt: activatedAt,
    });
    await makeInteraction(agent.id, {
      sessionId: "collide",
      source: "chat",
      cost: "0.2000000000",
      createdAt: turnAt,
    });
    // A session id is caller-chosen, so another tenant reusing it must not be
    // attributed to this skill.
    await makeInteraction(foreignAgent.id, {
      sessionId: "collide",
      source: "chat",
      cost: "40.0000000000",
      createdAt: turnAt,
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "contextTokens",
      sortDirection: "desc",
    });

    const row = result.data.find((entry) => entry.skillId === skill.id);
    expect(row?.attributedRequests).toBe(1);
    expect(row?.attributedCost).toBeCloseTo(0.2, 10);
  });

  test("omits skills outside the caller's scope", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [visible, hidden] = await Promise.all([
      SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name: "visible" }),
        files: [],
      }),
      SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name: "hidden" }),
        files: [],
      }),
    ]);
    if (!visible || !hidden) throw new Error("seed failed");
    await seedActivation({
      skillId: visible.id,
      userId: user.id,
      sessionId: "a",
    });
    await seedActivation({
      skillId: hidden.id,
      userId: user.id,
      sessionId: "b",
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "activations",
      sortDirection: "desc",
      accessibleSkillIds: [visible.id],
    });

    expect(result.data.map((entry) => entry.skillId)).toEqual([visible.id]);
  });

  test("omits skills of another organization", async ({
    makeOrganization,
    makeUser,
  }) => {
    const [org, otherOrg] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const user = await makeUser();
    const foreign = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: otherOrg.id, name: "foreign" }),
      files: [],
    });
    if (!foreign) throw new Error("seed failed");
    await seedActivation({
      skillId: foreign.id,
      userId: user.id,
      sessionId: "c",
    });

    const result = await StatisticsModel.getSkillStatistics({
      timeframe: "24h",
      organizationId: org.id,
      pagination: PAGE,
      sortBy: "activations",
      sortDirection: "desc",
    });

    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});
