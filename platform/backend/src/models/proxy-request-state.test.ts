import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import AgentTeamModel from "./agent-team";
import EnvironmentModel from "./environment";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import LimitModel, { LimitValidationService } from "./limit";
import ModelModel from "./model";
import ProxyRequestContextModel from "./proxy-request-context";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamLabelModel from "./team-label";

test("one scoped read preserves grants, labels, both credentials and typed budget/default rows", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeAgent,
  makeVirtualApiKey,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const first = await makeTeam(org.id, user.id);
  const second = await makeTeam(org.id, user.id);
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
