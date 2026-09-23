import config from "@/config";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import routes from "./openappa-coverage.routes";

describe("GET /api/openappa/coverage/tools", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const tools = async (query = "") => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      data: Array<{
        fullName: string;
        catalogId: string;
        catalogIcon: string | null;
        policySource: string;
        rule: {
          selector: string | null;
          source: string;
          battery: string | null;
        } | null;
      }>;
      servers: Array<{ id: string; name: string; icon: string | null }>;
      pagination: Record<string, unknown>;
    };
  };
  /** Rows as `name` or `name(selector)`. */
  const rows = async (query: string) =>
    (await tools(query)).data.map((row) =>
      row.rule?.selector
        ? `${row.fullName}(${row.rule.selector})`
        : row.fullName,
    );

  const seed = (fixtures: Parameters<typeof seedCoverage>[0]["fixtures"]) =>
    seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures,
      github: true,
    });

  test("is not found while Guardrails v2 is disabled", async () => {
    config.openappa.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/tools",
    });
    expect(response.statusCode).toBe(404);
  });

  test("an organization with nothing installed lists no tool", async () => {
    expect(await tools()).toEqual({
      data: [],
      servers: [],
      pagination: expect.objectContaining({ total: 0 }),
    });
  });

  test("lists unlisted tools first, then those not enforced, and pages them", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    await seed({ makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool });

    expect(await rows("")).toEqual([
      "docs__list_pages",
      "gh__get_me",
      "mixed__get_me",
      "acme__create_item",
      "acme__delete_item",
      "acme__list_items",
      "acme__ping",
      "docs__microsoft_docs_fetch",
      "docs__microsoft_docs_search",
      "docs__microsoft_docs_search(query:*azure*)",
      "mixed__list_items",
    ]);
    const page = await tools("?limit=3&offset=3");
    expect(page.data.map((row) => row.fullName)).toEqual([
      "acme__create_item",
      "acme__delete_item",
      "acme__list_items",
    ]);
    expect(page.pagination).toMatchObject({
      currentPage: 2,
      total: 11,
      totalPages: 4,
    });
  });

  test("filters by search, server, what governs the row and its kind", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds } = await seed({
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    });

    // The tool name, its selector, the server name or its prefix.
    expect(await rows("?search=AZURE")).toEqual([
      "docs__microsoft_docs_search(query:*azure*)",
    ]);
    expect(await rows("?search=mixed")).toEqual([
      "mixed__get_me",
      "mixed__list_items",
    ]);
    expect(await rows(`?catalogId=${catalogIds.acme}`)).toEqual([
      "acme__create_item",
      "acme__delete_item",
      "acme__list_items",
      "acme__ping",
    ]);
    expect(await rows("?governedBy=root")).toEqual([
      "acme__delete_item",
      "acme__ping",
      "docs__microsoft_docs_search(query:*azure*)",
    ]);
    expect(await rows("?governedBy=battery")).toEqual([
      "gh__get_me",
      "mixed__get_me",
      "acme__create_item",
      "acme__list_items",
      "docs__microsoft_docs_fetch",
      "docs__microsoft_docs_search",
      "mixed__list_items",
    ]);
    expect(await rows("?governedBy=catchall")).toEqual(["docs__list_pages"]);
    expect(await rows("?kind=read")).toEqual([
      "acme__list_items",
      "docs__microsoft_docs_search(query:*azure*)",
      "mixed__list_items",
    ]);
    // A rule that needs approval is a write too.
    expect(await rows("?kind=write")).toEqual([
      "acme__create_item",
      "acme__delete_item",
      "docs__microsoft_docs_fetch",
      "docs__microsoft_docs_search",
    ]);
    expect(await rows("?kind=approval")).toEqual(["acme__create_item"]);
  });

  test("lists server filters for a target across all pages and keeps icons", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { agentIds, catalogIds } = await seed({
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    });
    const firstPage = await tools(`?entityId=${agentIds.alpha}&limit=1`);
    expect(firstPage.servers).toEqual([
      { id: catalogIds.acme, name: "Acme", icon: null },
      { id: catalogIds.docs, name: "Docs", icon: "📚" },
    ]);
    expect(firstPage.data).toHaveLength(1);
    const filtered = await tools(
      `?entityId=${agentIds.alpha}&catalogId=${catalogIds.docs}`,
    );
    expect(filtered.data.map((tool) => tool.fullName)).toEqual([
      "docs__list_pages",
    ]);
    expect(filtered.data[0]).toMatchObject({ catalogIcon: "📚" });
    expect(filtered.servers).toEqual(firstPage.servers);
  });

  test("identifies root, battery, and fallback policy sources in entity details", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    await seed({ makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool });
    const listed = (await tools("?limit=100")).data;
    expect(
      listed.find((row) => row.fullName === "acme__delete_item"),
    ).toMatchObject({
      policySource: "root",
      rule: { source: "root", battery: null },
    });
    expect(
      listed.find((row) => row.fullName === "acme__list_items"),
    ).toMatchObject({
      policySource: "battery",
      rule: { source: "battery", battery: "acme" },
    });
    expect(
      listed.find((row) => row.fullName === "docs__list_pages"),
    ).toMatchObject({
      policySource: "fallback",
      rule: null,
    });
  });
});
