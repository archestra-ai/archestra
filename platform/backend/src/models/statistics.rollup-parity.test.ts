import type { StatisticsTimeFrame } from "@archestra/shared";
import db, { schema } from "@/database";
import { llmUsageRollup } from "@/services/llm-usage-rollup";
import { describe, expect, test } from "@/test";
import StatisticsModel from "./statistics";
import UsageStatisticsModel from "./usage-statistics";

/**
 * Every statistic reads the same numbers whether its hours come from raw
 * interactions or from the hourly rollup: each view is read before the rollup
 * has rolled anything (all raw) and again once it has rolled every hour.
 */
describe("cost statistics over the hourly rollup", () => {
  test("every view matches its raw-row result", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const alice = await makeUser({ name: "Alice" });
    const bob = await makeUser({ name: "Bob" });
    for (const user of [alice, bob]) await makeMember(user.id, org.id);
    const research = await makeTeam(org.id, alice.id, { name: "Research" });
    const platform = await makeTeam(org.id, bob.id, { name: "Platform" });
    await makeTeamMember(research.id, alice.id);
    await makeTeamMember(platform.id, bob.id);
    const shared = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: { teams: [research.id, platform.id] },
    });
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });

    const now = Date.now();
    const at = (hours: number) => new Date(now - hours * 3600_000);
    const usage = [
      { agent: shared, user: alice, hoursAgo: 70.4, model: "claude-sonnet" },
      { agent: shared, user: bob, hoursAgo: 30.75, model: "gpt-4o" },
      { agent: proxy, user: alice, hoursAgo: 20.5, model: "gpt-4o" },
      { agent: proxy, user: bob, hoursAgo: 6.1, model: "claude-sonnet" },
      { agent: shared, user: alice, hoursAgo: 2.2, model: "o3" },
      // Requests sharing an hour (and some keys) with the ones above.
      { agent: shared, user: alice, hoursAgo: 70.3, model: "claude-sonnet" },
      { agent: proxy, user: bob, hoursAgo: 6.05, model: "gpt-4o" },
      { agent: shared, user: alice, hoursAgo: 2.15, model: "o3" },
      // Too recent to be rolled: always read raw.
      { agent: proxy, user: alice, hoursAgo: 0.05, model: "gpt-4o" },
    ];
    for (const [index, row] of usage.entries()) {
      const interaction = await makeInteraction(row.agent.id, {
        createdAt: at(row.hoursAgo),
        userId: row.user.id,
        model: row.model,
        type: index % 2 ? "openai:chatCompletions" : "anthropic:messages",
        inputTokens: 1000 + index,
        inputTokensEstimated: index === 3,
        outputTokens: 100 + index,
        cacheReadTokens: 10 * index,
        cacheWriteTokens: index,
        cost: String(1 + index / 10),
        baselineCost: String(2 + index / 10),
        cacheSavings: String(index / 100),
        billingMode: index === 1 ? "subscription" : "metered",
        billingTeamId: index === 2 ? platform.id : undefined,
        authMethod: index % 2 ? "virtual_key" : "oauth_client_credentials",
        authenticatedAppId: index % 2 ? undefined : "app-1",
        authenticatedAppName: index % 2 ? undefined : "CI pipeline",
        attributionLabels: { cost_center: index % 2 ? "eng" : "ops" },
        attemptOutcome: index === 4 ? "failed_over" : undefined,
        externalAgentId: index % 2 ? "claude-code" : undefined,
      });
      if (index % 3 === 0) {
        await db.insert(schema.interactionBillingTable).values({
          interactionId: interaction.id,
          organizationId: org.id,
          billingMode: "metered",
          fingerprint: `parity-${interaction.id}`,
          usage: {
            version: 1,
            mode: "enforce",
            status: "complete",
            issues: [],
            cost: "3",
            components: [
              component(row.model, "message", "2", 600),
              component("claude-haiku", "advisor_message", "1", 300),
            ],
          },
        });
      }
    }

    const read = (timeframe: StatisticsTimeFrame) =>
      readEveryView({
        timeframe,
        organizationId: org.id,
        userId: alice.id,
        teamIds: [research.id],
      });
    const timeframes: StatisticsTimeFrame[] = [
      "24h",
      "7d",
      "30d",
      `custom:${at(71).toISOString()}_${at(5.5).toISOString()}`,
    ];

    const raw = await Promise.all(timeframes.map(read));
    await drain();
    const rolled = await Promise.all(timeframes.map(read));

    const [{ rows }] = await Promise.all([
      db.execute<{ hours: number }>(
        "SELECT COUNT(DISTINCT hour)::int AS hours FROM llm_usage_hourly",
      ),
    ]);
    expect(rows[0].hours).toBeGreaterThan(0);
    expect(rolled).toEqual(raw);
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function readEveryView(params: {
  timeframe: StatisticsTimeFrame;
  organizationId: string;
  userId: string;
  teamIds: string[];
}) {
  const { timeframe, organizationId, userId, teamIds } = params;
  const page = { limit: 50, offset: 0 };
  return {
    costs: await StatisticsModel.getCostStatistics({
      timeframe,
      organizationId,
      requestingUserId: userId,
      canReadAllUsers: true,
    }),
    teamCosts: await StatisticsModel.getCostStatistics({
      timeframe,
      organizationId,
      requestingUserId: userId,
      canReadAllUsers: false,
      teamIds,
    }),
    models: await StatisticsModel.getModelStatistics({
      timeframe,
      organizationId,
    }),
    savings: await StatisticsModel.getCostSavingsStatistics({
      timeframe,
      organizationId,
    }),
    teams: await StatisticsModel.getTeamStatistics({
      timeframe,
      organizationId,
    }),
    adminTeams: await StatisticsModel.getTeamStatistics({
      timeframe,
      organizationId,
      teamIds,
    }),
    agents: await StatisticsModel.getAgentStatistics({
      timeframe,
      organizationId,
    }),
    users: await StatisticsModel.getUserStatistics({
      timeframe,
      organizationId,
      pagination: page,
      sortBy: "lastActiveAt",
      sortDirection: "desc",
      includeTimeSeries: true,
      includeModels: true,
      includeModelTimeSeries: true,
      requestingUserId: userId,
      canReadAllUsers: true,
    }),
    mine: await StatisticsModel.getMyStatistics({
      timeframe,
      userId,
      organizationId,
    }),
    proxy: await StatisticsModel.getProxyCostStatistics({
      timeframe,
      organizationId,
      ...page,
      labelKey: "cost_center",
      includeLabelKeys: true,
      includeProviderKeys: true,
      includeModelPools: true,
      includeGroupTimeSeries: true,
    }),
    modelUsage: await Promise.all(
      (["person", "key", "agent", "client"] as const).map((groupBy) =>
        StatisticsModel.getModelUsage({
          model: "claude-haiku",
          groupBy,
          timeframe,
          organizationId,
          ...page,
        }),
      ),
    ),
    llmUsage: await Promise.all(
      (
        [
          ["teamId", "model"],
          ["credentialId", "provider"],
          ["day", "agentId", "userId"],
          ["provider"],
        ] as const
      ).map((groupBy) =>
        UsageStatisticsModel.getLlmUsage({
          timeframe,
          organizationId,
          pagination: page,
          groupBy: [...groupBy],
        }),
      ),
    ),
  };
}

function component(
  model: string,
  kind: "message" | "advisor_message",
  cost: string,
  inputTokens: number,
) {
  return {
    id: `${kind}-${model}`,
    model,
    kind,
    inputTokens,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 0,
    provider: "openai" as const,
    prices: {
      input: "1",
      output: "2",
      cacheRead: "0.1",
      cacheWrite: "1.25",
      cacheWrite1h: null,
      source: "test",
    },
    cost,
  };
}

/** Run the rollup until nothing is left to roll, recompute or settle. */
async function drain() {
  for (let run = 0; run < 20; run++) {
    const result = await llmUsageRollup.run({
      timeBudgetMs: 60_000,
      throttleRatio: 0,
    });
    if (result.recomputed === 0 && result.rolled === 0) return;
  }
  throw new Error("rollup did not drain");
}
