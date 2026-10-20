import config from "@/config";
import ToolModel from "@/models/tool";
import { beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { coverageVisibility, openappaCoverageService } from "./coverage";

beforeEach(() => {
  config.openappa.enabled = true;
});

describe("openappaCoverageService.toolsForCatalog", () => {
  test("returns the organization-wide report's rows for that catalog", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const { catalogIds, toolIds } = await seedCoverage({
      organizationId: organization.id,
      userId: user.id,
      fixtures: { makeAgent, makeAgentTool, makeInternalMcpCatalog, makeTool },
      github: true,
    });
    const gateway = await makeAgent({
      organizationId: organization.id,
      name: "Delta",
      agentType: "mcp_gateway",
    });
    for (const tool of [
      "docs__microsoft_docs_search",
      "acme__create_item",
      "mixed__get_me",
      "mixed__list_items",
    ])
      await makeAgentTool(gateway.id, toolIds[tool]);

    const visibility = await coverageVisibility(user.id, organization.id);
    const report = await openappaCoverageService.tools({
      ...visibility,
      organizationId: organization.id,
      limit: 1000,
      offset: 0,
    });
    expect(new Set(report.data.map((tool) => tool.catalogId))).toEqual(
      new Set(
        Object.values(catalogIds).filter((id) => id !== catalogIds.linear),
      ),
    );

    for (const catalogId of Object.values(catalogIds)) {
      const scoped = await openappaCoverageService.toolsForCatalog({
        ...visibility,
        visibleCatalogIds: [catalogId],
        organizationId: organization.id,
        catalogId,
      });
      expect(scoped).toEqual(
        report.data.filter((tool) => tool.catalogId === catalogId),
      );
    }
  });
});

describe("coverage server pages", () => {
  test("metadata pages retain full-report counts, ordering, visibility and filters", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const { catalogIds } = await seedCoverage({
      organizationId: organization.id,
      userId: user.id,
      fixtures: { makeAgent, makeAgentTool, makeInternalMcpCatalog, makeTool },
      github: true,
    });
    const visibility = await coverageVisibility(user.id, organization.id);
    // The reader can see a subset: the hidden server must not affect pages or totals.
    const params = {
      ...visibility,
      organizationId: organization.id,
      visibleCatalogIds: visibility.visibleCatalogIds.filter(
        (id) => id !== catalogIds.acme,
      ),
    };
    // Count sorting deliberately retains the full visible-tool report path.
    const baseline = await openappaCoverageService.entities({
      ...params,
      sortBy: "tools",
      limit: 100,
      offset: 0,
    });
    expect(baseline.data.some((row) => row.id === catalogIds.acme)).toBe(false);
    expect(baseline.data.some((row) => row.toolCount === 0)).toBe(true);
    for (const sortDirection of ["asc", "desc"] as const) {
      const ordered = [...baseline.data].sort((a, b) => {
        const alphabetical =
          a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        return sortDirection === "desc" ? -alphabetical : alphabetical;
      });
      const result = await openappaCoverageService.entities({
        ...params,
        sortBy: "name",
        sortDirection,
        limit: 2,
        offset: 1,
      });
      expect(result.data).toEqual(ordered.slice(1, 3));
      expect(result.pagination.total).toBe(ordered.length);
    }
    const searched = await openappaCoverageService.entities({
      ...params,
      search: "dOC",
      limit: 10,
      offset: 0,
    });
    expect(searched.data).toEqual(
      baseline.data.filter((row) => row.name.toLowerCase().includes("doc")),
    );
    const hidden = await openappaCoverageService.entities({
      ...params,
      entityId: catalogIds.acme,
      limit: 10,
      offset: 0,
    });
    expect(hidden.data).toEqual([]);
    expect(hidden.pagination.total).toBe(0);
    const beyond = await openappaCoverageService.entities({
      ...params,
      limit: 10,
      offset: 1000,
    });
    expect(beyond.data).toEqual([]);
    expect(beyond.pagination.total).toBe(baseline.pagination.total);
  });
});

describe("ToolModel.findCoverageInventory", () => {
  test("narrows catalogs and tools to one catalog", async ({
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const scopedCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "Scoped",
    });
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "Other",
    });
    const scopedTool = await makeTool({
      catalogId: scopedCatalog.id,
      name: "scoped__lookup",
    });
    const otherTool = await makeTool({
      catalogId: otherCatalog.id,
      name: "other__lookup",
    });

    const whole = await ToolModel.findCoverageInventory(organization.id);
    const scoped = await ToolModel.findCoverageInventory(organization.id, {
      catalogId: scopedCatalog.id,
    });

    expect(whole.tools.map((tool) => tool.id).sort()).toEqual(
      [scopedTool.id, otherTool.id].sort(),
    );
    expect(scoped.catalogs.map((catalog) => catalog.id)).toEqual([
      scopedCatalog.id,
    ]);
    expect(scoped.tools.map((tool) => tool.id)).toEqual([scopedTool.id]);

    const page = await ToolModel.findCoverageInventory(organization.id, {
      catalogIds: [scopedCatalog.id],
    });
    expect(page).toEqual(scoped);
    expect(
      await ToolModel.findCoverageInventory(organization.id, {
        catalogIds: [],
      }),
    ).toEqual({ catalogs: [], tools: [] });
  });
});

describe("openappaCoverageService.rulesForTools", () => {
  test("names each tool's rule with its TOML, from the root, a battery or the catch-all", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    await seedCoverage({
      organizationId: organization.id,
      userId: user.id,
      fixtures: { makeAgent, makeAgentTool, makeInternalMcpCatalog, makeTool },
    });

    const rules = await openappaCoverageService.rulesForTools({
      organizationId: organization.id,
      toolNames: [
        "acme__delete_item",
        "docs__microsoft_docs_search",
        "acme__nothing_names_this",
      ],
    });

    expect(rules.get("acme__delete_item")).toMatchObject({
      rule: { source: "root", name: "acme__delete_item" },
      text: [
        "[[policy.tool]]",
        'name = "acme__delete_item"',
        "delta = {}",
        'forwards = { audience = ["self"] }',
        'requires = { trust = "trusted" }',
      ].join("\n"),
    });
    // The root's rule for it has a selector, which depends on the arguments;
    // the included battery's rule names it outright.
    expect(rules.get("docs__microsoft_docs_search")).toMatchObject({
      rule: {
        source: "battery",
        name: "mcp/microsoft-learn/microsoft_docs_search",
      },
      text: [
        "[[policy.tool]]",
        'name = "mcp/microsoft-learn/microsoft_docs_search"',
        'delta = { trust = "suspicious" }',
        'requires = { audience = { contains = ["public"] } }',
      ].join("\n"),
    });
    expect(rules.get("acme__nothing_names_this")).toMatchObject({
      rule: { source: "catchall", name: "*" },
      text: '[[policy.tool]]\nname = "*"\nannotator = "noop"',
    });
  });
});
