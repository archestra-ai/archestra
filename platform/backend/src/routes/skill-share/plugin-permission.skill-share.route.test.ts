import {
  ADMIN_ROLE_NAME,
  type ResourcePermissionAction,
} from "@archestra/shared";
import config from "@/config";
import { PluginModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import skillShareRoutes from "./skill-share.routes";

beforeEach(() => {
  config.beta = false;
});

describe("executable marketplace link permissions", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("publishing plugins takes organization-wide plugin sharing and use of every plugin on the link", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Share permission hook",
        description: "Permission boundary test",
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

    // `use` on every plugin installs them without the right to share one
    // with everybody; `accessPolicies:update` shares anything organization-
    // wide without using the plugin. A public link needs both.
    const cases: Array<{
      permission: Record<string, string[]>;
      pluginActions: ResourcePermissionAction[];
      status: number;
    }> = [
      { permission: {}, pluginActions: ["read", "use"], status: 403 },
      {
        permission: { accessPolicies: ["update"] },
        pluginActions: [],
        status: 403,
      },
      {
        permission: {},
        pluginActions: ["read", "use", "manage-permissions"],
        status: 200,
      },
    ];
    for (const { permission, pluginActions, status } of cases) {
      const role = await makeCustomRole(ctx.organizationId, {
        permission: { plugin: ["read"], ...permission },
      });
      // The skill marketplace gate every link passes first.
      await grantRoleEverywhere({
        organizationId: ctx.organizationId,
        resource: "skill",
        roleId: role.id,
        actions: ["read", "use", "manage-permissions"],
      });
      if (pluginActions.length)
        await grantRoleEverywhere({
          organizationId: ctx.organizationId,
          resource: "plugin",
          roleId: role.id,
          actions: pluginActions,
        });
      ctx.user = await makeUser();
      await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: {
          skillIds: [],
          pluginIds: [plugin.id],
          pluginPlatform: "posix",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(
        response.statusCode,
        `${JSON.stringify({ permission, pluginActions })}: ${response.body}`,
      ).toBe(status);
    }
  });
});
