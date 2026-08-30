import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { BundleModel, PluginModel } from "@/models";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import { seedSkill } from "../skill-share/skill-share.test-helpers";
import bundleRoutes from "./bundle.routes";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    bundles: { enabled: true },
  }),
);

vi.mock("@/auth");

import { userHasPermission } from "@/auth";

describe("bundle CRUD", () => {
  const ctx = useRouteTestApp(bundleRoutes);

  beforeEach(() => {
    vi.mocked(userHasPermission).mockResolvedValue(true);
  });

  test("an admin can create, list, update, and delete a bundle", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "bundle-skill",
    });

    const createdResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/bundles",
      payload: {
        name: "Software engineer",
        description: "Engineering baseline",
        skillIds: [skill.id, skill.id],
        pluginIds: [],
      },
    });
    expect(createdResponse.statusCode).toBe(200);
    const created = createdResponse.json();
    expect(created).toMatchObject({
      name: "Software engineer",
      description: "Engineering baseline",
      skillIds: [skill.id],
      pluginIds: [],
      mcpGatewayId: null,
    });

    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/bundles",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);

    const updatedResponse = await ctx.app.inject({
      method: "PATCH",
      url: `/api/bundles/${created.id}`,
      payload: { name: "Platform engineer", skillIds: [] },
    });
    expect(updatedResponse.statusCode).toBe(200);
    expect(updatedResponse.json()).toMatchObject({
      id: created.id,
      name: "Platform engineer",
      skillIds: [],
    });

    const deleteResponse = await ctx.app.inject({
      method: "DELETE",
      url: `/api/bundles/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/bundles/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
  });

  test("rejects replacing Bundle plugin membership without plugin:admin", async () => {
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Bundle Hook",
        description: "Executable bundle membership",
        clientType: "claude-code",
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    const bundle = await BundleModel.create({
      organizationId: ctx.organizationId,
      name: "No plugins yet",
      description: "Permission test",
      mcpGatewayId: null,
      skillIds: [],
      pluginIds: [],
      localMcpServers: [],
    });
    vi.mocked(userHasPermission).mockImplementation(
      async (_userId, _organizationId, resource, action) =>
        !(resource === "plugin" && action === "admin"),
    );

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/bundles/${bundle.id}`,
      payload: { pluginIds: [plugin.id] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Plugin not found");
  });
});
