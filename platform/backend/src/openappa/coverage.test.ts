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

describe("ToolModel.findCoverageInventory", () => {
  test("narrows catalogs, tools and assignments to one catalog", async ({
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
    const { catalogIds, toolIds, agentIds } = await seedCoverage({
      organizationId: organization.id,
      userId: user.id,
      fixtures: { makeAgent, makeAgentTool, makeInternalMcpCatalog, makeTool },
    });

    const whole = await ToolModel.findCoverageInventory(organization.id);
    const scoped = await ToolModel.findCoverageInventory(organization.id, {
      catalogId: catalogIds.acme,
    });

    expect(scoped.catalogs.map((catalog) => catalog.id)).toEqual([
      catalogIds.acme,
    ]);
    expect(scoped.tools.map((tool) => tool.id).sort()).toEqual(
      [
        toolIds.acme__list_items,
        toolIds.acme__create_item,
        toolIds.acme__delete_item,
        toolIds.acme__ping,
      ].sort(),
    );
    expect(
      scoped.assignments
        .map(({ toolId, agentId }) => `${toolId}:${agentId}`)
        .sort(),
    ).toEqual(
      [
        `${toolIds.acme__list_items}:${agentIds.alpha}`,
        `${toolIds.acme__ping}:${agentIds.beta}`,
      ].sort(),
    );
    expect(scoped.entities).toEqual(whole.entities);
  });
});
