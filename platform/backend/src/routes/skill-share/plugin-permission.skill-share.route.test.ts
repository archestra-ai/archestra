import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { PluginModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import skillShareRoutes from "./skill-share.routes";

beforeEach(() => {
  config.plugins.enabled = true;
});

describe("executable marketplace link permissions", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("requires both plugin:read and plugin:admin", async ({
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

    // plugin:read is a role permission; plugin:admin is an update grant at `*`.
    const cases: Array<[Record<string, string[]>, boolean]> = [
      [{ plugin: ["read"] }, false],
      [{}, true],
    ];
    for (const [permission, pluginAdmin] of cases) {
      const role = await makeCustomRole(ctx.organizationId, { permission });
      // The skill marketplace gate every link passes first.
      await grantRoleEverywhere({
        organizationId: ctx.organizationId,
        resource: "skill",
        roleId: role.id,
        actions: ["read", "use", "manage-permissions"],
      });
      if (pluginAdmin) {
        await grantRoleEverywhere({
          organizationId: ctx.organizationId,
          resource: "plugin",
          roleId: role.id,
          actions: ["update"],
        });
      }
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
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain("plugin:read");
    }
  });
});
