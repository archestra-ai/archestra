import type { StatisticsTimeFrame } from "@shared";
import { describe, expect, test } from "@/test";
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
        },
        {
          timeBucket: sameTimestamp,
          model: "claude-3",
          requests: 5,
          inputTokens: 800,
          outputTokens: 400,
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
        },
        {
          timeBucket: slightlyLater,
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
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
        },
        {
          timeBucket: sameTimestamp,
          teamId: "team-2",
          teamName: "Marketing",
          requests: 15,
          inputTokens: 1500,
          outputTokens: 750,
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
          teamName: null,
          requests: 100,
          inputTokens: 10000,
          outputTokens: 5000,
        },
        {
          timeBucket: sameTimestamp,
          agentId: "agent-2",
          agentName: "Assistant",
          teamName: null,
          requests: 50,
          inputTokens: 5000,
          outputTokens: 2500,
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
        },
      ];

      // 24h uses 60-minute buckets, which should pass through unchanged
      const result = StatisticsModel.groupTimeSeries(data, "24h", "model");

      expect(result).toEqual(data);
    });

    test("should sort results by time bucket", () => {
      const data = [
        {
          timeBucket: "2024-01-15T10:30:00.000Z",
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
        },
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: "gpt-4",
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
        },
        {
          timeBucket: "2024-01-15T10:15:00.000Z",
          model: "gpt-4",
          requests: 8,
          inputTokens: 800,
          outputTokens: 400,
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
        },
        {
          timeBucket: "2024-01-15T10:00:00.000Z",
          model: undefined as unknown as string,
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
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
        },
        {
          timeBucket: "2024-01-15T10:02:00.000Z", // Same bucket as above
          model: "gpt-4",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
        },
        {
          timeBucket: "2024-01-15T10:01:00.000Z",
          model: "claude-3",
          requests: 8,
          inputTokens: 800,
          outputTokens: 400,
        },
        // Second 5-minute bucket (10:10-10:15) - two models
        {
          timeBucket: "2024-01-15T10:10:00.000Z",
          model: "gpt-4",
          requests: 20,
          inputTokens: 2000,
          outputTokens: 1000,
        },
        {
          timeBucket: "2024-01-15T10:12:00.000Z",
          model: "claude-3",
          requests: 12,
          inputTokens: 1200,
          outputTokens: 600,
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
  });
});
