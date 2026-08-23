import { createHash } from "node:crypto";
import { MCP_SKILLS_EXTENSION_ID } from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import {
  ExternalMcpSkillUsageEventModel,
  McpCatalogSkillModel,
} from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  useRouteTestApp,
} from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import externalMcpSkillRoutes from "./external-mcp-skill.routes";

describe("external MCP Skill routes", () => {
  const ctx = useRouteTestApp(externalMcpSkillRoutes);
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.mcpGateway.skillsEnabled;
    config.mcpGateway.skillsEnabled = true;
  });

  afterEach(() => {
    config.mcpGateway.skillsEnabled = originalEnabled;
    vi.restoreAllMocks();
  });

  test("routes are absent while the beta gate is off", async () => {
    config.mcpGateway.skillsEnabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/external",
    });
    expect(response.statusCode).toBe(404);

    const statisticsResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/external/usage-statistics?mcpServerId=00000000-0000-4000-8000-000000000000&uri=skill%3A%2F%2Fexample%2Frelease%2FSKILL.md",
    });
    expect(statisticsResponse.statusCode).toBe(404);
  });

  test("lists only skills backed by an installation visible to the caller", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeMcpServer,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      scope: "org",
      icon: "🛰️",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
      ownerId: ctx.user.id,
    });
    await McpCatalogSkillModel.syncCatalog({
      catalogId: catalog.id,
      generation: (await McpCatalogSkillModel.beginRefresh(catalog.id)) ?? 0,
      skills: [metadata()],
    });
    ExternalMcpSkillUsageEventModel.recordUsage({
      mcpServerId: server.id,
      uri: metadata().uri,
      userId: ctx.user.id,
    });
    ExternalMcpSkillUsageEventModel.recordUsage({
      mcpServerId: server.id,
      uri: metadata().uri,
      userId: null,
    });
    await drainBackgroundWork();

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills/external",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        source: "external_mcp",
        mcpServerId: server.id,
        catalogId: catalog.id,
        name: "release",
        icon: "🛰️",
        usageCount: 2,
        usageUserCount: 1,
        lastUsedAt: expect.any(String),
      }),
    ]);

    const statisticsQuery = new URLSearchParams({
      mcpServerId: server.id,
      uri: metadata().uri,
    });
    const statisticsResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/external/usage-statistics?${statisticsQuery.toString()}`,
    });
    expect(statisticsResponse.statusCode).toBe(200);
    const statistics = statisticsResponse.json();
    expect(statistics.users).toEqual(
      expect.arrayContaining([
        {
          userId: ctx.user.id,
          name: ctx.user.name,
          total: 1,
        },
        { userId: null, name: null, total: 1 },
      ]),
    );
    expect(
      statistics.daily.reduce(
        (sum: number, bucket: { count: number }) => sum + bucket.count,
        0,
      ),
    ).toBe(2);
  });

  test("usage statistics do not expose an inaccessible installation", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeMcpServer,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrganization = await makeOrganization();
    const otherUser = await makeUser({ email: "external-usage@test.com" });
    await makeMember(ctx.user.id, ctx.organizationId);
    await makeMember(otherUser.id, otherOrganization.id);
    await makeMember(otherUser.id, ctx.organizationId);
    const catalog = await makeInternalMcpCatalog({
      organizationId: null,
      scope: "org",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
      ownerId: otherUser.id,
    });
    await McpCatalogSkillModel.syncCatalog({
      catalogId: catalog.id,
      generation: (await McpCatalogSkillModel.beginRefresh(catalog.id)) ?? 0,
      skills: [metadata()],
    });

    const query = new URLSearchParams({
      mcpServerId: server.id,
      uri: metadata().uri,
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/external/usage-statistics?${query.toString()}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("detail reads the current source bytes rather than stored content", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      scope: "org",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
    });
    await McpCatalogSkillModel.syncCatalog({
      catalogId: catalog.id,
      generation: (await McpCatalogSkillModel.beginRefresh(catalog.id)) ?? 0,
      skills: [metadata()],
    });
    const [stored] = await McpCatalogSkillModel.findByCatalogIds([catalog.id]);
    const manifest =
      "---\nname: release\ndescription: Current.\n---\n# current source";
    const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    vi.spyOn(mcpClient, "withSkillsSession").mockImplementation(
      async ({ run }) =>
        run(
          {
            request: vi.fn(async () => ({
              skill: {
                uri: "skill://example/release/SKILL.md",
                frontmatter: { name: "release", description: "Current." },
                resources: [
                  { uri: "skill://example/release/SKILL.md", digest },
                ],
              },
            })),
            readResource: vi.fn(async () => ({
              contents: [
                {
                  uri: "skill://example/release/SKILL.md",
                  text: manifest,
                },
              ],
            })),
          } as never,
          {
            serverExtensions: () => ({ [MCP_SKILLS_EXTENSION_ID]: {} }),
          },
        ),
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/skills/external/${stored.id}?mcpServerId=${server.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      content: "# current source",
      description: "Current.",
    });
  });
});

function metadata() {
  return {
    uri: "skill://example/release/SKILL.md",
    name: "release",
    description: "Listed.",
    frontmatter: { name: "release", description: "Listed." },
    resources: [
      {
        uri: "skill://example/release/SKILL.md",
        digest: "sha256:listed",
      },
    ],
  };
}
