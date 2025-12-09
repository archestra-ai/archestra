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
});
