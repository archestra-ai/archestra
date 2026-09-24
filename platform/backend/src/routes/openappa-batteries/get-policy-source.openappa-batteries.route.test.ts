import config from "@/config";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import routes from "./openappa-batteries.routes";

describe("GET /api/openappa/battery-policy-source", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("reads the exact included battery TOML and rejects stale entries", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { content } = await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
    });
    const entry = /batteries\/acme@sha256-[a-f0-9]+\/appa\.toml/.exec(
      content,
    )?.[0];
    expect(entry).toBeTruthy();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/battery-policy-source?entry=${encodeURIComponent(entry ?? "")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entry,
      name: "acme",
      content: expect.stringContaining('name = "mcp/acme/list_items"'),
    });
    expect(response.json().content.split("\n")[3]).toBe("[[policy.tool]]");

    const stale = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/battery-policy-source?entry=batteries%2Facme%2Fappa.toml",
    });
    expect(stale.statusCode).toBe(404);
  });
});
