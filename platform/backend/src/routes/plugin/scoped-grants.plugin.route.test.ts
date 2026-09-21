// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import config from "@/config";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import pluginRoutes from "./plugin.routes";

const AUTHOR_ACTIONS = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];

describe("scoped plugin grants", () => {
  const ctx = useRouteTestApp(pluginRoutes);

  beforeEach(async ({ makeMember }) => {
    config.plugins.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("shares a plugin with a named user at creation", async ({
    makeUser,
    makeMember,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, ctx.organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, ctx.organizationId);

    const grants = [
      {
        subject: { type: "user" as const, id: recipient.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Shared at creation",
        clientType: "claude-code",
        files: [{ path: "hooks/hook.json", content: "{}" }],
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "plugin",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      { subject: { type: "user", id: ctx.user.id }, actions: AUTHOR_ACTIONS },
    ]);

    const scoped = {
      organizationId: ctx.organizationId,
      resource: "plugin" as const,
      scope: id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: recipient.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(["read", "use"]);
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
  });

  test("rejects a grant naming someone outside the organization", async ({
    makeUser,
  }) => {
    const stranger = await makeUser();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/plugins",
      payload: {
        displayName: "Rejected",
        clientType: "claude-code",
        files: [{ path: "hooks/hook.json", content: "{}" }],
        initialGrants: [
          {
            subject: { type: "user", id: stranger.id },
            actions: ["read"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
