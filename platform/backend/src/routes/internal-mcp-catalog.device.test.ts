import OrganizationModel from "@/models/organization";
import ToolModel from "@/models/tool";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

const deviceConfig = {
  protocolVersion: 1 as const,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["server.mjs"] },
    win32: { command: "node.exe", args: ["C:/server.mjs"] },
  },
  tools: [
    {
      name: "echo",
      description: "Echo text",
      inputSchema: {
        type: "object" as const,
        properties: { text: { type: "string" } },
      },
    },
  ],
};

describe("device registry configuration", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);

  test("refuses device registry creation until the organization opts in", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: { name: "device-tools", serverType: "device", deviceConfig },
    });
    expect(result.statusCode).toBe(403);
  });

  test("publishes reviewed tool schemas and removes obsolete tools when the manifest changes", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: { name: "device-tools", serverType: "device", deviceConfig },
    });
    expect(result.statusCode).toBe(200);
    const catalogId = result.json().id;
    const tools = await ToolModel.findByCatalogId(catalogId, {
      kind: "caller",
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(ToolModel.slugifyName("device-tools", "echo"));
    expect(tools[0].parameters).toEqual(deviceConfig.tools[0].inputSchema);

    const update = await ctx.app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        deviceConfig: {
          ...deviceConfig,
          version: "2.0.0",
          tools: [{ ...deviceConfig.tools[0], name: "echo_v2" }],
        },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(
      (
        await ToolModel.findByCatalogId(catalogId, {
          kind: "caller",
          userId: ctx.user.id,
          organizationId: ctx.organizationId,
        })
      ).map((tool) => tool.name),
    ).toEqual([ToolModel.slugifyName("device-tools", "echo_v2")]);
  });

  test("refuses shared credential defaults and missing reviewed configuration", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    for (const extra of [
      { deviceConfig: null },
      { deviceConfig, multitenant: true },
      {
        deviceConfig,
        dynamicConnectionMcpServerId: "00000000-0000-4000-8000-000000000001",
      },
    ]) {
      const result = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "invalid-device-tools",
          serverType: "device",
          ...extra,
        },
      });
      expect(result.statusCode).toBe(400);
    }
  });
});
