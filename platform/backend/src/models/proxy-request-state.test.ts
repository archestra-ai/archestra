import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import AgentTeamModel from "./agent-team";
import EnvironmentModel from "./environment";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import LimitModel, { LimitValidationService } from "./limit";
import LlmThroughputModel from "./llm-throughput";
import ModelModel from "./model";
import ProxyRequestContextModel from "./proxy-request-context";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamLabelModel from "./team-label";

test("one scoped read preserves grants, labels, both credentials and typed budget/default rows", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeAgent,
  makeVirtualApiKey,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const first = await makeTeam(org.id, user.id);
  const second = await makeTeam(org.id, user.id);
  // The caller is in `first` directly and in `second` through a sub-team.
  await makeTeamMember(first.id, user.id);
  const secondChild = await makeTeam(org.id, user.id, { parentId: second.id });
  await makeTeamMember(secondChild.id, user.id);
  await TeamLabelModel.syncTeamLabels(first.id, [
    { key: "environment", value: "synthetic" },
  ]);
  const environment = await EnvironmentModel.create({
    organizationId: org.id,
    name: "Snapshot environment",
  });
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "agent",
    environmentId: environment.id,
    access: { teams: [second.id, first.id] },
  });
  const key = await makeVirtualApiKey(org.id);
  const passthrough = await makeVirtualApiKey(org.id);
  const params = {
    organizationId: org.id,
    provider: "openai" as const,
    modelId: "unseen-model",
    agentId: agent.id,
    environmentId: environment.id,
    userId: user.id,
    virtualKeyId: key.id,
    limitVirtualKeyId: key.id,
    passthroughVirtualKeyId: passthrough.id,
    teamMemberUserId: user.id,
  };
  for (const [entityType, entityId] of [
    ["agent", agent.id],
    ["organization", org.id],
    ["environment", environment.id],
    ["user", user.id],
    ["team", first.id],
    ["team", second.id],
    ["virtual_key", key.id],
    ["virtual_key", passthrough.id],
  ] as const)
    await LimitModel.create({
      entityType,
      entityId,
      limitType: "token_cost",
      limitValue: 17,
      cleanupInterval: "24h",
      model: ['quoted-"model', "unicode-λ"],
    });
  await EnvironmentDefaultUserLimitModel.create({
    organizationId: org.id,
    limitValue: 23,
  });
  const override = await EnvironmentDefaultUserLimitModel.create({
    organizationId: org.id,
    environmentId: environment.id,
    limitValue: 31,
    model: ["unicode-λ"],
    cleanupInterval: "calendar_week_monday",
  });
  const expected = await LimitModel.findProxyLimitState(
    {
      agent: agent.id,
      organization: org.id,
      environment: environment.id,
      user: user.id,
      team: [first.id, second.id],
      virtual_key: [key.id, passthrough.id],
    },
    { organizationId: org.id, environmentId: environment.id },
  );
  const state = await ProxyRequestContextModel.readForProxy(params);
  expect(state.model).toBeNull();
  expect(state.agentTeamIds).toEqual(
    await AgentTeamModel.getTeamsForAgent(agent.id),
  );
  expect(state.agentTeams).toEqual(
    await AgentTeamModel.getTeamLabelInfoForAgent(agent.id),
  );
  expect(
    state.limitState.limits.toSorted((a, b) => a.id.localeCompare(b.id)),
  ).toEqual(expected.limits.toSorted((a, b) => a.id.localeCompare(b.id)));
  expect(state.limitState.defaultUserLimit).toEqual(override);
  expect(state.limitState.defaultUserLimit?.createdAt).toBeInstanceOf(Date);
  expect(state.limitState.limits[0].createdAt).toBeInstanceOf(Date);
  expect(state.limitTeamIds.toSorted()).toEqual(
    [first.id, second.id].toSorted(),
  );

  // A caller in none of the agent's teams meets none of their limits.
  const outsider = await ProxyRequestContextModel.readForProxy({
    ...params,
    teamMemberUserId: null,
  });
  expect(outsider.limitTeamIds).toEqual([]);
  expect(outsider.limitState.limits.some((l) => l.entityType === "team")).toBe(
    false,
  );
  expect(outsider.agentTeamIds).toEqual(state.agentTeamIds);

  const billed = await ProxyRequestContextModel.readForProxy({
    ...params,
    billingTeamId: second.id,
  });
  expect(
    billed.limitState.limits
      .filter((l) => l.entityType === "team")
      .map((l) => l.entityId),
  ).toEqual([second.id]);
  expect(billed.limitState.limits.some((l) => l.entityType === "user")).toBe(
    false,
  );
  expect(billed.agentTeamIds).toEqual(state.agentTeamIds);

  const policyKey = {
    organizationId: org.id,
    resource: "agent" as const,
    scope: agent.id,
  };
  const policy = await ResourcePermissionPolicyModel.find(policyKey);
  await ResourcePermissionPolicyModel.replace({
    ...policyKey,
    revision: policy?.revision ?? 0,
    grants: [
      { subject: { type: "team", id: first.id }, actions: ["read", "use"] },
    ],
  });
  const refreshed = await ProxyRequestContextModel.readForProxy(params);
  expect(refreshed.agentTeamIds).toEqual([first.id]);
  expect(
    refreshed.limitState.limits.some(
      (l) => l.entityType === "team" && l.entityId === second.id,
    ),
  ).toBe(false);
  await EnvironmentDefaultUserLimitModel.delete(override.id);
  expect(
    (await ProxyRequestContextModel.readForProxy(params)).limitState
      .defaultUserLimit?.limitValue,
  ).toBe(23);
});

test("scoped snapshots enforce spend, reject reuse for a different agent and reread after cleanup", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const other = await makeAgent({ organizationId: org.id });
  const model = await ModelModel.create({
    externalId: "openai/scoped-budget",
    provider: "openai",
    modelId: "scoped-budget",
    inputModalities: ["text"],
    outputModalities: ["text"],
    promptPricePerToken: "1",
    completionPricePerToken: "1",
  });
  const limit = await LimitModel.create({
    entityType: "agent",
    entityId: agent.id,
    limitType: "token_cost",
    limitValue: 1,
    cleanupInterval: "24h",
    model: [model.modelId],
  });
  await LimitModel.patch(limit.id, { lastCleanup: new Date() });
  await LimitModel.recordInteractionTokenUsage({
    agentId: agent.id,
    teamIds: [],
    entities: [],
    model: model.modelId,
    inputTokens: 2,
    outputTokens: 0,
  });
  const read = (id: string) =>
    ProxyRequestContextModel.readForProxy({
      agentId: id,
      organizationId: org.id,
      environmentId: null,
      provider: "openai",
      modelId: model.modelId,
    });
  const params = {
    agentId: agent.id,
    agent: { organizationId: org.id, environmentId: null },
  };
  const snapshot = await read(agent.id);
  const original =
    await LimitValidationService.checkLimitsBeforeRequest(params);
  expect(original).not.toBeNull();
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      ...params,
      snapshot,
    }),
  ).toEqual(original);
  const wrongAgent = await read(other.id);
  expect(wrongAgent.limitState.limits).toEqual([]);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      ...params,
      snapshot: wrongAgent,
    }),
  ).toEqual(original);

  await db
    .update(schema.limitsTable)
    .set({ lastCleanup: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    .where(eq(schema.limitsTable.id, limit.id));
  const expired = await read(agent.id);
  expect(expired.limitState.limits[0].cleanupDue).toBe(true);
  expect(expired.limitState.limits[0].lastCleanup).toBeInstanceOf(Date);
  expect(
    await LimitValidationService.checkLimitsBeforeRequest({
      ...params,
      snapshot: expired,
    }),
  ).toBeNull();
  const usage = await db
    .select()
    .from(schema.limitModelUsageTable)
    .where(eq(schema.limitModelUsageTable.limitId, limit.id));
  expect(
    usage.reduce((total, row) => total + row.currentUsageTokensIn, 0),
  ).toBe(0);
  expect((await read(agent.id)).limitState.limits[0].cleanupDue).toBe(false);
});

test("the request state carries its entities' throughput rules, and admission enforces them", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const rule = await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "requests",
    cleanupInterval: "calendar_day",
    limitValue: 1,
  });
  await LimitModel.create({
    entityType: "organization",
    entityId: other.id,
    limitType: "requests",
    cleanupInterval: "calendar_day",
    limitValue: 1,
  });
  // A spend budget is not a throughput rule.
  await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    cleanupInterval: "24h",
    limitValue: 5,
  });

  const state = await ProxyRequestContextModel.readForProxy({
    organizationId: org.id,
    provider: "openai",
    modelId: "m",
    agentId: agent.id,
    environmentId: agent.environmentId ?? null,
  });
  expect(state.throughputRules.map((r) => r.id)).toEqual([rule.id]);

  const scope = {
    entities: [{ entityType: "organization" as const, entityId: org.id }],
    model: "m",
    rules: state.throughputRules,
  };
  await LlmThroughputModel.admit(scope);
  await expect(LlmThroughputModel.admit(scope)).resolves.toMatchObject({
    denied: { entityType: "organization", limitType: "requests" },
  });
});
