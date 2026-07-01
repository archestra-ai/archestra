import type { StatisticsTimeFrame } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import StatisticsModel from "./statistics";

describe("StatisticsModel", () => {
  describe("parseCustomTimeframe", () => {
    test("should parse valid custom timeframe", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      await makeOrganization();

      // Test the private method via the public methods that use it
      const startTime = "2024-01-01T00:00:00.000Z";
      const endTime = "2024-01-02T23:59:59.999Z";
      const customTimeframe: StatisticsTimeFrame = `custom:${startTime}_${endTime}`;

      // This should not throw an error if parsing works
      const result = await StatisticsModel.getTeamStatistics(
        customTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should handle invalid custom timeframe format", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      await makeOrganization();

      // Test with invalid format - missing underscore
      const invalidTimeframe =
        "custom:2024-01-01T00:00:00.000Z" as StatisticsTimeFrame;

      // Should not throw but should handle gracefully
      const result = await StatisticsModel.getTeamStatistics(
        invalidTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should handle invalid date strings", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      await makeOrganization();

      const invalidTimeframe =
        "custom:invalid-date_also-invalid" as StatisticsTimeFrame;

      // Should not throw but should handle gracefully
      const result = await StatisticsModel.getTeamStatistics(
        invalidTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getTeamStatistics", () => {
    test("should return team statistics for standard timeframes", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      const result = await StatisticsModel.getTeamStatistics(
        "24h",
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should return team statistics for custom timeframes", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      const startTime = new Date();
      startTime.setHours(startTime.getHours() - 2); // 2 hours ago
      const endTime = new Date(); // now

      const customTimeframe: StatisticsTimeFrame = `custom:${startTime.toISOString()}_${endTime.toISOString()}`;

      const result = await StatisticsModel.getTeamStatistics(
        customTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should filter by accessible agents for non-admin users", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      // Test as non-admin (isAgentAdmin = false)
      const result = await StatisticsModel.getTeamStatistics(
        "24h",
        user.id,
        false,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("counts team members per team instead of per organization", async ({
      makeAgent,
      makeInteraction,
      makeMember,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const users = await Promise.all([
        makeUser(),
        makeUser(),
        makeUser(),
        makeUser(),
      ]);

      await Promise.all(users.map((user) => makeMember(user.id, org.id)));

      const teamAlpha = await makeTeam(org.id, users[0].id, {
        name: "Team Alpha",
      });
      const teamBeta = await makeTeam(org.id, users[0].id, {
        name: "Team Beta",
      });

      await makeTeamMember(teamAlpha.id, users[0].id);
      await Promise.all(
        users.slice(1).map((user) => makeTeamMember(teamBeta.id, user.id)),
      );

      const alphaAgent = await makeAgent({
        organizationId: org.id,
        teams: [teamAlpha.id],
      });
      const betaAgent = await makeAgent({
        organizationId: org.id,
        teams: [teamBeta.id],
      });

      await makeInteraction(alphaAgent.id, {
        inputTokens: 100,
        outputTokens: 50,
      });
      await makeInteraction(betaAgent.id, {
        inputTokens: 300,
        outputTokens: 80,
      });

      const stats = await StatisticsModel.getTeamStatistics(
        "24h",
        users[0].id,
        true,
      );

      expect(
        Object.fromEntries(
          stats.map((team) => [team.teamName, team.members] as const),
        ),
      ).toMatchObject({
        "Team Alpha": 1,
        "Team Beta": 3,
      });
    });
  });

  describe("getAgentStatistics", () => {
    test("should return agent statistics for standard timeframes", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      const result = await StatisticsModel.getAgentStatistics(
        "7d",
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should return agent statistics for custom timeframes", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const today = new Date();

      const customTimeframe: StatisticsTimeFrame = `custom:${yesterday.toISOString()}_${today.toISOString()}`;

      const result = await StatisticsModel.getAgentStatistics(
        customTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("excludes interactions for soft-deleted agents", async ({
      makeAgent,
      makeInteraction,
      makeUser,
    }) => {
      const user = await makeUser();
      const activeAgent = await makeAgent({ name: "Active Stats Agent" });
      const deletedAgent = await makeAgent({ name: "Deleted Stats Agent" });
      await makeInteraction(activeAgent.id, {
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 100,
      });
      await makeInteraction(deletedAgent.id, {
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 100,
      });

      await AgentModel.delete(deletedAgent.id);

      const result = await StatisticsModel.getAgentStatistics(
        "24h",
        user.id,
        true,
      );

      expect(result.map((row) => row.agentId)).toContain(activeAgent.id);
      expect(result.map((row) => row.agentId)).not.toContain(deletedAgent.id);
    });
  });

  describe("getModelStatistics", () => {
    test("should return model statistics for standard timeframes", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      const result = await StatisticsModel.getModelStatistics(
        "30d",
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should return model statistics for custom timeframes", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const now = new Date();

      const customTimeframe: StatisticsTimeFrame = `custom:${weekAgo.toISOString()}_${now.toISOString()}`;

      const result = await StatisticsModel.getModelStatistics(
        customTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    test("should calculate percentages correctly", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      const result = await StatisticsModel.getModelStatistics(
        "all",
        user.id,
        true,
      );

      // Verify percentages add up to 100% (or close to it due to rounding)
      const totalPercentage = result.reduce(
        (sum, model) => sum + model.percentage,
        0,
      );
      if (result.length > 0) {
        expect(totalPercentage).toBeGreaterThanOrEqual(99);
        expect(totalPercentage).toBeLessThanOrEqual(101);
      }
    });
  });

  describe("getOverviewStatistics", () => {
    test("should return overview statistics", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      const result = await StatisticsModel.getOverviewStatistics(
        "24h",
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(typeof result.totalRequests).toBe("number");
      expect(typeof result.totalTokens).toBe("number");
      expect(typeof result.totalCost).toBe("number");
      expect(typeof result.topTeam).toBe("string");
      expect(typeof result.topAgent).toBe("string");
      expect(typeof result.topModel).toBe("string");
    });

    test("should work with custom timeframes", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      const now = new Date();

      const customTimeframe: StatisticsTimeFrame = `custom:${monthAgo.toISOString()}_${now.toISOString()}`;

      const result = await StatisticsModel.getOverviewStatistics(
        customTimeframe,
        user.id,
        true,
      );
      expect(result).toBeDefined();
      expect(typeof result.totalRequests).toBe("number");
      expect(typeof result.totalTokens).toBe("number");
      expect(typeof result.totalCost).toBe("number");
    });
  });

  describe("time bucket logic", () => {
    test("should handle different time ranges for custom timeframes", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      await makeOrganization();
      await makeAgent();

      // Test short timeframe (should use minute buckets)
      const shortStart = new Date();
      shortStart.setHours(shortStart.getHours() - 1); // 1 hour ago
      const shortEnd = new Date();
      const shortCustom: StatisticsTimeFrame = `custom:${shortStart.toISOString()}_${shortEnd.toISOString()}`;

      const shortResult = await StatisticsModel.getTeamStatistics(
        shortCustom,
        user.id,
        true,
      );
      expect(shortResult).toBeDefined();

      // Test long timeframe (should use day/week buckets)
      const longStart = new Date();
      longStart.setMonth(longStart.getMonth() - 2); // 2 months ago
      const longEnd = new Date();
      const longCustom: StatisticsTimeFrame = `custom:${longStart.toISOString()}_${longEnd.toISOString()}`;

      const longResult = await StatisticsModel.getTeamStatistics(
        longCustom,
        user.id,
        true,
      );
      expect(longResult).toBeDefined();
    });
  });

  describe("edge cases", () => {
    test("should handle empty results gracefully", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      await makeOrganization();

      // No agents or teams created, should return empty arrays
      const teamResult = await StatisticsModel.getTeamStatistics(
        "24h",
        user.id,
        true,
      );
      const agentResult = await StatisticsModel.getAgentStatistics(
        "24h",
        user.id,
        true,
      );
      const modelResult = await StatisticsModel.getModelStatistics(
        "24h",
        user.id,
        true,
      );

      expect(teamResult).toEqual([]);
      expect(agentResult).toEqual([]);
      expect(modelResult).toEqual([]);
    });

    test("should handle users with no accessible agents", async ({
      makeUser,
      makeOrganization,
      makeTeam,
      makeAgent,
    }) => {
      const user = await makeUser(); // Regular user without admin permissions
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      await makeAgent({ teams: [team.id] });

      // Test as non-admin user (isAgentAdmin = false)
      // Non-admin users should only see agents they have access to through team membership
      const result = await StatisticsModel.getTeamStatistics(
        "24h",
        user.id,
        false, // isAgentAdmin = false
      );

      // Result might be empty if user doesn't have access to any agents
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("groupTimeSeries", () => {
    test("should preserve separate entries for different models in same time bucket", () => {
      const sameTimestamp = "2024-01-15T10:00:00.000Z";

      const data = [
        {
          timeBucket: sameTimestamp,
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
        {
          timeBucket: sameTimestamp,
          model: "claude-3",
          requests: 5,
          inputTokens: 800,
          outputTokens: 400,
          cost: 0.08,
        },
      ];

      // Use "1h" timeframe which triggers grouping (5-minute buckets)
      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      // Should have 2 separate entries, one for each model
      expect(result).toHaveLength(2);

      const gpt4Entry = result.find((r) => r.model === "gpt-4");
      const claudeEntry = result.find((r) => r.model === "claude-3");

      expect(gpt4Entry).toBeDefined();
      expect(claudeEntry).toBeDefined();
      expect(gpt4Entry?.requests).toBe(10);
      expect(claudeEntry?.requests).toBe(5);
    });

    test("should aggregate data for same model across same time bucket", () => {
      // Use "1h" timeframe which uses 5-minute buckets
      // Both timestamps are in the same 5-minute bucket (10:00-10:05)
      const sameTimestamp = "2024-01-15T10:01:00.000Z";
      const slightlyLater = "2024-01-15T10:02:00.000Z";

      const data = [
        {
          timeBucket: sameTimestamp,
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 100,
          cost: 0.05,
        },
        {
          timeBucket: slightlyLater,
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          cacheReadTokens: 8448,
          cost: 0.025,
        },
      ];

      // "1h" uses 5-minute buckets, so these should aggregate
      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      // Should aggregate into single entry
      expect(result).toHaveLength(1);
      expect(result[0].model).toBe("gpt-4");
      expect(result[0].requests).toBe(15);
      expect(result[0].inputTokens).toBe(1500);
      expect(result[0].outputTokens).toBe(750);
      expect(result[0].cost).toBeCloseTo(0.075);
      // cacheReadTokens must sum across merged rows, not keep the first row's
      // value — regression guard for cache reads vanishing at fine timeframes.
      expect((result[0] as { cacheReadTokens: number }).cacheReadTokens).toBe(
        8548,
      );
    });

    test("should preserve separate entries for different teams in same time bucket", () => {
      const sameTimestamp = "2024-01-15T10:00:00.000Z";

      const data = [
        {
          timeBucket: sameTimestamp,
          teamId: "team-1",
          teamName: "Engineering",
          requests: 20,
          inputTokens: 2000,
          outputTokens: 1000,
          cost: 0.1,
        },
        {
          timeBucket: sameTimestamp,
          teamId: "team-2",
          teamName: "Marketing",
          requests: 15,
          inputTokens: 1500,
          outputTokens: 750,
          cost: 0.075,
        },
      ];

      // Use "1h" timeframe which triggers grouping
      const result = StatisticsModel.groupTimeSeries(data, "1h", "teamId");

      expect(result).toHaveLength(2);

      const team1 = result.find((r) => r.teamId === "team-1");
      const team2 = result.find((r) => r.teamId === "team-2");

      expect(team1?.requests).toBe(20);
      expect(team2?.requests).toBe(15);
    });

    test("should preserve separate entries for different agents in same time bucket", () => {
      const sameTimestamp = "2024-01-15T10:00:00.000Z";

      const data = [
        {
          timeBucket: sameTimestamp,
          agentId: "agent-1",
          agentName: "Chatbot",
          agentType: "llm_proxy",
          teamName: null,
          requests: 100,
          inputTokens: 10000,
          outputTokens: 5000,
          cost: 0.5,
        },
        {
          timeBucket: sameTimestamp,
          agentId: "agent-2",
          agentName: "Assistant",
          agentType: "llm_proxy",
          teamName: null,
          requests: 50,
          inputTokens: 5000,
          outputTokens: 2500,
          cost: 0.25,
        },
      ];

      // Use "1h" timeframe which triggers grouping
      const result = StatisticsModel.groupTimeSeries(data, "1h", "agentId");

      expect(result).toHaveLength(2);

      const agent1 = result.find(
        (r): r is Extract<typeof r, { agentId: string }> =>
          "agentId" in r && r.agentId === "agent-1",
      );
      const agent2 = result.find(
        (r): r is Extract<typeof r, { agentId: string }> =>
          "agentId" in r && r.agentId === "agent-2",
      );

      expect(agent1?.requests).toBe(100);
      expect(agent2?.requests).toBe(50);
    });

    test("should handle empty input array", () => {
      // Use "1h" timeframe which triggers grouping
      const result = StatisticsModel.groupTimeSeries([], "1h", "model");
      expect(result).toEqual([]);
    });

    test("should return data unchanged for standard intervals (24h)", () => {
      const data = [
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
      ];

      // 24h uses 60-minute buckets, which should pass through unchanged
      const result = StatisticsModel.groupTimeSeries(data, "24h", "model");

      expect(result).toEqual(data);
    });

    test("should coerce string numeric values to numbers in early return path", () => {
      // Simulate what PostgreSQL returns: DOUBLE PRECISION / DECIMAL as strings
      // through node-postgres, which causes Zod z.number() validation failures
      const data = [
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: "gpt-4",
          requests: "10" as unknown as number,
          inputTokens: "1000" as unknown as number,
          outputTokens: "500" as unknown as number,
          cost: "0.05" as unknown as number,
        },
        {
          timeBucket: "2024-01-15T11:00:00.000Z",
          model: "claude-3",
          requests: "5" as unknown as number,
          inputTokens: "800" as unknown as number,
          outputTokens: "400" as unknown as number,
          cost: "0.12345" as unknown as number,
        },
      ];

      // 24h uses standard intervals (early return path, no custom grouping)
      const result = StatisticsModel.groupTimeSeries(data, "24h", "model");

      // All numeric fields should be actual numbers, not strings
      for (const row of result) {
        expect(typeof row.requests).toBe("number");
        expect(typeof row.inputTokens).toBe("number");
        expect(typeof row.outputTokens).toBe("number");
        expect(typeof row.cost).toBe("number");
      }

      expect(result[0].requests).toBe(10);
      expect(result[0].cost).toBe(0.05);
      expect(result[1].requests).toBe(5);
      expect(result[1].cost).toBe(0.12345);
    });

    test("should sort results by time bucket", () => {
      const data = [
        {
          timeBucket: "2024-01-15T10:30:00.000Z",
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          cost: 0.025,
        },
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
        {
          timeBucket: "2024-01-15T10:15:00.000Z",
          model: "gpt-4",
          requests: 8,
          inputTokens: 800,
          outputTokens: 400,
          cost: 0.04,
        },
      ];

      // Use "1h" timeframe which triggers grouping
      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      // Should be sorted by time
      expect(new Date(result[0].timeBucket).getTime()).toBeLessThan(
        new Date(result[1].timeBucket).getTime(),
      );
      expect(new Date(result[1].timeBucket).getTime()).toBeLessThan(
        new Date(result[2].timeBucket).getTime(),
      );
    });

    test("should handle null/undefined groupBy values", () => {
      const data = [
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: null as unknown as string,
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: undefined as unknown as string,
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          cost: 0.025,
        },
      ];

      // Use "1h" timeframe which triggers grouping
      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      // Both null and undefined should be grouped as "unknown"
      expect(result).toHaveLength(1);
      expect(result[0].requests).toBe(15);
    });

    test("should correctly aggregate multiple models across multiple time buckets", () => {
      // Using "1h" timeframe which uses 5-minute buckets
      const data = [
        // First 5-minute bucket (10:00-10:05) - two models
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
        {
          timeBucket: "2024-01-15T10:02:00.000Z", // Same bucket as above
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          cost: 0.025,
        },
        {
          timeBucket: "2024-01-15T10:01:00.000Z",
          model: "claude-3",
          requests: 8,
          inputTokens: 800,
          outputTokens: 400,
          cost: 0.08,
        },
        // Second 5-minute bucket (10:10-10:15) - two models
        {
          timeBucket: "2024-01-15T10:10:00.000Z",
          model: "gpt-4",
          requests: 20,
          inputTokens: 2000,
          outputTokens: 1000,
          cost: 0.1,
        },
        {
          timeBucket: "2024-01-15T10:12:00.000Z",
          model: "claude-3",
          requests: 12,
          inputTokens: 1200,
          outputTokens: 600,
          cost: 0.12,
        },
      ];

      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      // Should have 4 entries: 2 models × 2 time buckets
      expect(result).toHaveLength(4);

      // First bucket gpt-4: 10 + 5 = 15 requests
      const bucket1Gpt4 = result.find(
        (r) =>
          r.model === "gpt-4" && new Date(r.timeBucket).getUTCMinutes() === 0,
      );
      expect(bucket1Gpt4?.requests).toBe(15);

      // First bucket claude-3: 8 requests
      const bucket1Claude = result.find(
        (r) =>
          r.model === "claude-3" &&
          new Date(r.timeBucket).getUTCMinutes() === 0,
      );
      expect(bucket1Claude?.requests).toBe(8);

      // Second bucket gpt-4: 20 requests
      const bucket2Gpt4 = result.find(
        (r) =>
          r.model === "gpt-4" && new Date(r.timeBucket).getUTCMinutes() === 10,
      );
      expect(bucket2Gpt4?.requests).toBe(20);

      // Second bucket claude-3: 12 requests
      const bucket2Claude = result.find(
        (r) =>
          r.model === "claude-3" &&
          new Date(r.timeBucket).getUTCMinutes() === 10,
      );
      expect(bucket2Claude?.requests).toBe(12);
    });

    test("should aggregate cost field correctly", () => {
      // Verify cost is aggregated correctly when grouping
      const data = [
        {
          timeBucket: "2024-01-15T10:01:00.000Z",
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.05,
        },
        {
          timeBucket: "2024-01-15T10:02:00.000Z",
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          cost: 0.1, // Different cost rate
        },
      ];

      const result = StatisticsModel.groupTimeSeries(data, "1h", "model");

      expect(result).toHaveLength(1);
      expect(result[0].cost).toBeCloseTo(0.15);
    });

    test("buckets 90d data into 3-day windows without projecting timestamps into the future", () => {
      // Regression guard: the old day-bucketing treated "days since the epoch"
      // as "day of year" and added it to Jan 1 of the row's year, projecting
      // 90d buckets ~56 years into the future (e.g. 2024 -> 2080).
      const data = [
        {
          timeBucket: "2024-02-02T00:00:00.000Z",
          model: "gpt-4",
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
        },
        {
          timeBucket: "2024-02-03T00:00:00.000Z",
          model: "gpt-4",
          requests: 2,
          inputTokens: 20,
          outputTokens: 10,
          cost: 0.02,
        },
        {
          timeBucket: "2024-02-10T00:00:00.000Z",
          model: "gpt-4",
          requests: 4,
          inputTokens: 40,
          outputTokens: 20,
          cost: 0.04,
        },
      ];

      const result = StatisticsModel.groupTimeSeries(data, "90d", "model");

      // Every bucket timestamp must stay in the input's year, not decades later.
      for (const row of result) {
        expect(new Date(row.timeBucket).getUTCFullYear()).toBe(2024);
      }
      // Feb 2 and Feb 3 share the 3-day window starting Feb 2 (UTC, epoch-aligned);
      // Feb 10 falls in a later window.
      expect(result).toHaveLength(2);
      const [first, second] = result;
      expect(first.timeBucket).toBe("2024-02-02T00:00:00.000Z");
      expect(first.requests).toBe(3);
      expect(first.cost).toBeCloseTo(0.03);
      expect(second.timeBucket).toBe("2024-02-08T00:00:00.000Z");
      expect(second.requests).toBe(4);
      // No cost is lost during re-bucketing.
      const totalCost = result.reduce((sum, row) => sum + row.cost, 0);
      expect(totalCost).toBeCloseTo(0.07);
    });

    test("aligns 7d buckets to UTC 6-hour boundaries", () => {
      const data = [
        {
          timeBucket: "2024-01-15T14:00:00.000Z",
          model: "gpt-4",
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
        },
        {
          timeBucket: "2024-01-15T17:00:00.000Z",
          model: "gpt-4",
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
        },
      ];

      const result = StatisticsModel.groupTimeSeries(data, "7d", "model");

      // 14:00 and 17:00 both fall in the 12:00-18:00 UTC window.
      expect(result).toHaveLength(1);
      expect(result[0].timeBucket).toBe("2024-01-15T12:00:00.000Z");
      expect(result[0].requests).toBe(2);
    });
  });

  describe("getCostSavingsStatistics", () => {
    test("reports real spend as actual cost and reconciles the savings breakdown", async ({
      makeUser,
      makeOrganization,
      makeAgent,
      makeInteraction,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });

      // Real spend 1.00; the same usage would have cost 1.50 on the original
      // model (0.50 optimization savings); TOON saved 0.20; cache saved 0.30.
      await makeInteraction(agent.id, {
        cost: "1.00",
        baselineCost: "1.50",
        toonCostSavings: "0.20",
        cacheSavings: "0.30",
      });

      const result = await StatisticsModel.getCostSavingsStatistics(
        "24h",
        user.id,
        true,
      );

      // Actual cost is the real spend — NOT real spend minus toon savings (the
      // savings are already baked into `cost`, so subtracting them double-counts).
      expect(result.totalActualCost).toBeCloseTo(1.0);
      expect(result.totalOptimizationSavings).toBeCloseTo(0.5);
      expect(result.totalToonSavings).toBeCloseTo(0.2);
      expect(result.totalCacheSavings).toBeCloseTo(0.3);
      // Non-optimized cost sits above actual by the sum of all three savings.
      expect(result.totalBaselineCost).toBeCloseTo(1.0 + 0.5 + 0.2 + 0.3);
      expect(result.totalSavings).toBeCloseTo(0.5 + 0.2 + 0.3);

      // The per-point gap between the non-optimized and actual lines must equal
      // the stacked savings breakdown, so the two charts reconcile.
      expect(result.timeSeries).toHaveLength(1);
      const point = result.timeSeries[0];
      expect(point.actualCost).toBeCloseTo(1.0);
      expect(point.baselineCost - point.actualCost).toBeCloseTo(
        point.optimizationSavings + point.toonSavings + point.cacheSavings,
      );
    });
  });
});
