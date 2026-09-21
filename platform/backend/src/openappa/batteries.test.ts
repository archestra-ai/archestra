import config from "@/config";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import ToolModel from "@/models/tool";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";

describe("battery attachment after a tool sync", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("a catalog matching a bundled battery is attached once and its organization recomposed", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    // Two syncs of one catalog can overlap; the second must neither duplicate nor fail.
    await Promise.all([
      openappaBatteriesService.onCatalogToolsChanged(catalog.id),
      openappaBatteriesService.onCatalogToolsChanged(catalog.id),
    ]);
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    const installs = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      batteryName: "github",
      catalogId: catalog.id,
      enabled: true,
    });

    // A name alone attaches the battery disabled, for an operator to confirm.
    const byName = await makeInternalMcpCatalog({
      organizationId,
      name: "Slack bridge test",
      serverUrl: "https://mcp.example.com/chat",
    });
    await openappaBatteriesService.onCatalogToolsChanged(byName.id);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).find(
        (install) => install.catalogId === byName.id,
      ),
    ).toMatchObject({ batteryName: "slack", enabled: false });
    expect(
      await OpenAppaEffectivePolicyModel.find(organizationId),
    ).toMatchObject({ rootRevision: 0, lastError: null });
    // A deleted catalog leaves the composition: its tools no longer target
    // the battery namespace, so the stored composition changes with it. The
    // notion battery has no helpers, so its install is active at once.
    const docs = await makeInternalMcpCatalog({
      organizationId,
      name: "Docs",
      serverUrl: "https://mcp.notion.com/mcp",
    });
    await makeTool({
      catalogId: docs.id,
      name: "notion__search",
      rawName: "search",
    });
    await openappaBatteriesService.onCatalogToolsChanged(docs.id);
    const before = await openappaBatteriesService.recompile(organizationId);
    await ToolModel.softDeleteByCatalog(docs.id, new Date());
    const after = await openappaBatteriesService.recompile(organizationId);
    expect(after.installFingerprint).not.toBe(before.installFingerprint);
    await expect(
      OpenAppaBatteryInstallModel.organizationIdsForCatalog(catalog.id),
    ).resolves.toEqual([organizationId]);
  });

  test("a catalog standing for no battery attaches nothing", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Internal wiki",
      serverUrl: "https://wiki.example.com/mcp",
    });
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual([]);
    expect(await OpenAppaEffectivePolicyModel.find(organizationId)).toBeNull();
  });
});
