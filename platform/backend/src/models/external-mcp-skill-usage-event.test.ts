import { ExternalMcpSkillUsageEventModel } from "@/models";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";

describe("ExternalMcpSkillUsageEventModel", () => {
  test("aggregates uses by installation and URI with distinct attributed users", async ({
    makeMcpServer,
    makeUser,
  }) => {
    const firstServer = await makeMcpServer();
    const secondServer = await makeMcpServer();
    const firstUser = await makeUser();
    const secondUser = await makeUser({
      email: "external-skill-user@test.com",
    });
    const primaryUri = "skill://example/release/SKILL.md";
    const otherUri = "skill://example/incidents/SKILL.md";

    for (const userId of [firstUser.id, firstUser.id, secondUser.id, null]) {
      ExternalMcpSkillUsageEventModel.recordUsage({
        mcpServerId: firstServer.id,
        uri: primaryUri,
        userId,
      });
    }
    ExternalMcpSkillUsageEventModel.recordUsage({
      mcpServerId: firstServer.id,
      uri: otherUri,
      userId: firstUser.id,
    });
    ExternalMcpSkillUsageEventModel.recordUsage({
      mcpServerId: secondServer.id,
      uri: primaryUri,
      userId: firstUser.id,
    });
    await drainBackgroundWork();

    const summaries = await ExternalMcpSkillUsageEventModel.getSummaries([
      { mcpServerId: firstServer.id, uri: primaryUri },
      { mcpServerId: firstServer.id, uri: otherUri },
      { mcpServerId: secondServer.id, uri: primaryUri },
      {
        mcpServerId: secondServer.id,
        uri: "skill://example/unused/SKILL.md",
      },
    ]);

    expect(summaries.get(firstServer.id)?.get(primaryUri)).toMatchObject({
      usageCount: 4,
      usageUserCount: 2,
      lastUsedAt: expect.any(Date),
    });
    expect(summaries.get(firstServer.id)?.get(otherUri)).toMatchObject({
      usageCount: 1,
      usageUserCount: 1,
    });
    expect(summaries.get(secondServer.id)?.get(primaryUri)).toMatchObject({
      usageCount: 1,
      usageUserCount: 1,
    });
    expect(
      summaries.get(secondServer.id)?.has("skill://example/unused/SKILL.md"),
    ).toBe(false);

    const statistics = await ExternalMcpSkillUsageEventModel.getUsageStatistics(
      {
        mcpServerId: firstServer.id,
        uri: primaryUri,
        since: new Date(Date.now() - 60 * 60 * 1000),
      },
    );
    expect(statistics.users).toEqual(
      expect.arrayContaining([
        { userId: firstUser.id, name: firstUser.name, total: 2 },
        { userId: secondUser.id, name: secondUser.name, total: 1 },
        { userId: null, name: null, total: 1 },
      ]),
    );
    expect(
      statistics.daily.reduce((sum, bucket) => sum + bucket.count, 0),
    ).toBe(4);
  });
});
