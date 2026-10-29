import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import InteractionModel from "./interaction";
import LimitModel, { LimitValidationService } from "./limit";
import LlmOauthClientModel from "./llm-oauth-client";
import StatisticsModel from "./statistics";

describe("credential billing team", () => {
  test("a billing team's limit replaces the proxy's team limits", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const proxyTeam = await makeTeam(org.id, user.id, { name: "Proxy team" });
    const billingTeam = await makeTeam(org.id, user.id, { name: "Billing" });
    const agent = await makeAgent({
      organizationId: org.id,
      access: { teams: [proxyTeam.id] },
    });
    await exhaustLimit({ entityType: "team", entityId: proxyTeam.id });

    // The proxy's team is over its limit, but the billing team pays.
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        billingTeamId: billingTeam.id,
      }),
    ).toBeNull();

    await exhaustLimit({ entityType: "team", entityId: billingTeam.id });
    const blocked = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      billingTeamId: billingTeam.id,
    });
    expect(blocked?.[1]).toContain("team-level");
  });

  test("the caller's personal limit does not apply when a team pays", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });
    await exhaustLimit({ entityType: "user", entityId: user.id });

    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
      }),
    ).not.toBeNull();
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
        billingTeamId: team.id,
      }),
    ).toBeNull();
  });

  test("usage is charged to the billing team, not the caller or the proxy's teams", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const proxyTeam = await makeTeam(org.id, user.id);
    const billingTeam = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      access: { teams: [proxyTeam.id] },
    });
    const [proxyTeamLimit, billingTeamLimit, userLimit] = await Promise.all(
      [
        { entityType: "team" as const, entityId: proxyTeam.id },
        { entityType: "team" as const, entityId: billingTeam.id },
        { entityType: "user" as const, entityId: user.id },
      ].map((entity) =>
        LimitModel.create({
          ...entity,
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
        }),
      ),
    );

    await createInteraction({
      agentId: agent.id,
      userId: user.id,
      billingTeamId: billingTeam.id,
    });
    await drainBackgroundWork();

    expect(await tokensIn(billingTeamLimit.id)).toBe(100);
    expect(await tokensIn(proxyTeamLimit.id)).toBe(0);
    expect(await tokensIn(userLimit.id)).toBe(0);
  });

  test("team statistics attribute team-billed spend to the billing team only", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const proxyTeam = await makeTeam(org.id, user.id, { name: "Proxy team" });
    const billingTeam = await makeTeam(org.id, user.id, {
      name: "Billing team",
    });
    const agent = await makeAgent({
      organizationId: org.id,
      access: { teams: [proxyTeam.id] },
    });
    await makeInteraction(agent.id, { inputTokens: 10, outputTokens: 0 });
    await makeInteraction(agent.id, {
      inputTokens: 500,
      outputTokens: 0,
      billingTeamId: billingTeam.id,
    });

    const stats = await StatisticsModel.getTeamStatistics({
      timeframe: "24h",
      organizationId: org.id,
    });
    const inputTokensByTeam = Object.fromEntries(
      stats.map((team) => [team.teamName, team.inputTokens] as const),
    );
    expect(inputTokensByTeam).toEqual({
      "Proxy team": 10,
      "Billing team": 500,
    });
  });
});

describe("LLM OAuth client spend cap", () => {
  test("blocks the client once its cap is spent and counts its usage", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "ci",
      authorId: user.id,
    });
    await LimitModel.setSpendCap({
      entityType: "llm_oauth_client",
      entityId: oauthClient.id,
      cap: { limitValue: 1000, cleanupInterval: "calendar_month" },
    });
    const cap = (
      await LimitModel.findSpendCaps({
        entityType: "llm_oauth_client",
        entityIds: [oauthClient.id],
      })
    ).get(oauthClient.id);
    if (!cap) throw new Error("spend cap was not created");

    await createInteraction({
      agentId: agent.id,
      authenticatedAppId: oauthClient.id,
    });
    await drainBackgroundWork();
    expect(await tokensIn(cap.limitId)).toBe(100);

    await LimitModel.setSpendCap({
      entityType: "llm_oauth_client",
      entityId: oauthClient.id,
      cap: { limitValue: 1, cleanupInterval: "calendar_month" },
    });
    await exhaustLimit({
      entityType: "llm_oauth_client",
      entityId: oauthClient.id,
      limitId: cap.limitId,
    });
    const blocked = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      llmOauthClientId: oauthClient.id,
    });
    expect(blocked?.[1]).toContain("OAuth client-level");
  });

  test("setSpendCap creates, changes, and removes one all-models limit", async ({
    makeOrganization,
    makeVirtualApiKey,
  }) => {
    const org = await makeOrganization();
    const key = await makeVirtualApiKey(org.id);
    const read = async () =>
      (
        await LimitModel.findSpendCaps({
          entityType: "virtual_key",
          entityIds: [key.id],
        })
      ).get(key.id);

    await LimitModel.setSpendCap({
      entityType: "virtual_key",
      entityId: key.id,
      cap: { limitValue: 500, cleanupInterval: "calendar_month" },
    });
    const created = await read();
    expect(created).toMatchObject({
      limitValue: 500,
      cleanupInterval: "calendar_month",
      currentUsage: 0,
    });

    await LimitModel.setSpendCap({
      entityType: "virtual_key",
      entityId: key.id,
      cap: { limitValue: 250, cleanupInterval: "1w" },
    });
    expect(await read()).toMatchObject({
      limitId: created?.limitId,
      limitValue: 250,
      cleanupInterval: "1w",
    });

    await LimitModel.setSpendCap({
      entityType: "virtual_key",
      entityId: key.id,
      cap: null,
    });
    expect(await read()).toBeUndefined();
  });

  test("deleting the client deletes its limits", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "ci",
      authorId: user.id,
    });
    await LimitModel.setSpendCap({
      entityType: "llm_oauth_client",
      entityId: oauthClient.id,
      cap: { limitValue: 10, cleanupInterval: "calendar_month" },
    });

    await LlmOauthClientModel.delete({
      id: oauthClient.id,
      organizationId: org.id,
    });

    expect(
      await LimitModel.findAll("llm_oauth_client", oauthClient.id),
    ).toHaveLength(0);
  });
});

// === helpers ===

async function exhaustLimit(params: {
  entityType: "team" | "user" | "llm_oauth_client";
  entityId: string;
  limitId?: string;
}) {
  const limitId =
    params.limitId ??
    (
      await LimitModel.create({
        entityType: params.entityType,
        entityId: params.entityId,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      })
    ).id;
  await LimitModel.updateTokenLimitUsage(
    params.entityType,
    params.entityId,
    "gpt-4o",
    1_000_000,
    1_000_000,
  );
  // Keep the window cleanup from resetting the usage just written.
  await LimitModel.patch(limitId, { lastCleanup: new Date() });
}

async function createInteraction(params: {
  agentId: string;
  userId?: string;
  billingTeamId?: string;
  authenticatedAppId?: string;
}) {
  await InteractionModel.create({
    profileId: params.agentId,
    userId: params.userId,
    billingTeamId: params.billingTeamId,
    authenticatedAppId: params.authenticatedAppId,
    model: "gpt-4o",
    inputTokens: 100,
    outputTokens: 0,
    request: { model: "gpt-4o", messages: [] },
    response: {
      id: "r1",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [],
    },
    type: "openai:chatCompletions",
  });
}

async function tokensIn(limitId: string): Promise<number> {
  const usage = await LimitModel.getRawModelUsage(limitId);
  return usage.reduce((sum, row) => sum + row.currentUsageTokensIn, 0);
}
