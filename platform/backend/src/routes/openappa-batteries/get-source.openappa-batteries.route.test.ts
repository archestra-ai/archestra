import config from "@/config";
import { openappaBatteriesService } from "@/openappa/batteries";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-batteries.routes";

describe("GET /api/openappa/batteries/:name/source", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const source = (name: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/openappa/batteries/${name}/source`,
    });
  const included = (entry: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/openappa/battery-policy-source?entry=${encodeURIComponent(entry)}`,
    });

  test("shows a battery's policy text before the policy includes it, the same text the include shows afterwards", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const entry = "batteries/microsoft-learn/appa.toml";
    const before = await source("microsoft-learn");
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({
      entry,
      name: "microsoft-learn",
      kind: "battery",
      content: expect.stringContaining("[[policy.tool]]"),
    });
    // Nothing includes it yet, so the policy itself has no such file.
    expect((await included(entry)).statusCode).toBe(404);

    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Docs",
      serverUrl: "https://learn.microsoft.com/api/mcp",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "docs__microsoft_docs_search",
      rawName: "microsoft_docs_search",
    });
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    const install = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "microsoft-learn", catalogId: catalog.id },
    });
    expect(install.statusCode, install.body).toBe(200);
    const after = await included(entry);
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().content).toBe(before.json().content);
    // The look at it stays the same once it is included.
    expect((await source("microsoft-learn")).json()).toEqual(before.json());
  });

  test("answers 404 for a name no battery has", async () => {
    const response = await source("no-such-battery");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe(
      "No battery is named no-such-battery",
    );
  });
});
