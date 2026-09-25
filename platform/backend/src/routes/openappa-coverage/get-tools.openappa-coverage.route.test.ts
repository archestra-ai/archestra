import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { ruleLine, seedCoverage } from "@/test/openappa-coverage";
import { useRouteTestApp } from "@/test/route-test-app";
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
        readOnly: boolean | null;
        catalogId: string;
        catalogIcon: string | null;
        policySource: string;
        fallbackLine: number | null;
        rule: {
          selector: string | null;
          source: string;
          battery: string | null;
          batteryEntry: string | null;
          batteryStatus: string | null;
          line: number | null;
          enforced: boolean;
        } | null;
      }>;
      servers: Array<{ id: string; name: string; icon: string | null }>;
      batteries: string[];
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
      batteries: [],
      pagination: expect.objectContaining({ total: 0 }),
    });
  });

  test("hides another member's personal catalog unless a visible agent reaches its tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId, { role: "member" });
    const privateCatalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      access: "personal",
      name: "Private server",
    });
    const privateTool = await makeTool({
      catalogId: privateCatalog.id,
      name: "private__lookup",
      rawName: "lookup",
    });
    const visibleCatalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Shared server",
    });
    await makeTool({
      catalogId: visibleCatalog.id,
      name: "shared__lookup",
      rawName: "lookup",
    });

    const viewer = await makeUser();
    await makeMember(viewer.id, ctx.organizationId, { role: "member" });
    ctx.user = viewer;

    const initial = await tools();
    expect(initial.data.map((tool) => tool.fullName)).toEqual([
      "shared__lookup",
    ]);
    expect(initial.servers.map((server) => server.id)).toEqual([
      visibleCatalog.id,
    ]);
    expect(initial.pagination).toMatchObject({ total: 1 });
    expect(await tools(`?catalogId=${privateCatalog.id}`)).toMatchObject({
      data: [],
      servers: [{ id: visibleCatalog.id }],
      pagination: { total: 0 },
    });

    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Shared agent",
    });
    await makeAgentTool(agent.id, privateTool.id);
    expect((await tools()).data.map((tool) => tool.fullName)).toEqual([
      "shared__lookup",
    ]);
    expect((await tools(`?catalogId=${privateCatalog.id}`)).data).toEqual([]);
    expect((await tools(`?entityId=${agent.id}`)).data).toEqual([
      expect.objectContaining({ fullName: "private__lookup" }),
    ]);
  });

  test("reports the server's read-only hint, and null without one", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Hints",
    });
    const hinted = (name: string, meta: Record<string, unknown> | undefined) =>
      makeTool({ catalogId: catalog.id, name: `hints__${name}`, meta });
    await hinted("read", { annotations: { readOnlyHint: true } });
    await hinted("write", { annotations: { readOnlyHint: false } });
    await hinted("odd", { annotations: { readOnlyHint: "maybe" } });
    await hinted("bare", undefined);

    const { data } = await tools(`?catalogId=${catalog.id}`);
    expect(
      Object.fromEntries(data.map((row) => [row.fullName, row.readOnly])),
    ).toEqual({
      hints__bare: null,
      hints__odd: null,
      hints__read: true,
      hints__write: false,
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
    expect(await rows("?governedBy=battery&battery=acme")).toEqual([
      "acme__create_item",
      "acme__list_items",
      "mixed__list_items",
    ]);
    expect(await rows("?governedBy=catchall")).toEqual(["docs__list_pages"]);
    expect(await rows("?governedBy=built_in")).toEqual([]);
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
    expect(firstPage.batteries).toEqual(["acme"]);
    expect(firstPage.data).toHaveLength(1);
    const filtered = await tools(
      `?entityId=${agentIds.alpha}&catalogId=${catalogIds.docs}`,
    );
    expect(filtered.data.map((tool) => tool.fullName)).toEqual([
      "docs__list_pages",
    ]);
    expect(filtered.data[0]).toMatchObject({ catalogIcon: "📚" });
    expect(filtered.servers).toEqual(firstPage.servers);
    expect(filtered.batteries).toEqual([]);
  });

  test("identifies root, battery, and fallback policy sources in entity details", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { content } = await seed({
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    });
    const listed = (await tools("?limit=100")).data;
    expect(
      listed.find((row) => row.fullName === "acme__delete_item"),
    ).toMatchObject({
      policySource: "root",
      rule: {
        source: "root",
        battery: null,
        batteryEntry: null,
        line: ruleLine(content, "acme__delete_item"),
      },
    });
    expect(
      listed.find((row) => row.fullName === "acme__list_items"),
    ).toMatchObject({
      policySource: "battery",
      rule: {
        source: "battery",
        battery: "acme",
        batteryEntry: expect.stringMatching(/^batteries\/acme@sha256-/),
        line: 4,
      },
    });
    expect(
      listed.find((row) => row.fullName === "docs__list_pages"),
    ).toMatchObject({
      policySource: "fallback",
      rule: null,
      fallbackLine: ruleLine(content, "*"),
    });
  });

  test("does not attribute a rejected catch-all to the active policy", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
      refused: true,
    });
    const listed = (await tools("?limit=100")).data;
    expect(
      listed.find((row) => row.fullName === "docs__list_pages"),
    ).toMatchObject({ policySource: "fallback", fallbackLine: null });
    expect(
      listed.find((row) => row.fullName === "acme__delete_item"),
    ).toMatchObject({
      policySource: "root",
      rule: { enforced: false },
    });
    expect(
      listed.find((row) => row.fullName === "acme__list_items"),
    ).toMatchObject({
      policySource: "battery",
      rule: { batteryStatus: "refused", enforced: false },
    });
  });
});
