// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionGrant } from "@archestra/shared";
import db from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import resourcePermissionRoutes from "./resource-permission.routes";

describe("scoped capabilities", () => {
  const ctx = useRouteTestApp(resourcePermissionRoutes);

  test("capabilities retain supported actions and ignore obsolete stored actions", async ({
    makeAgent,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const agent = await makeAgent({
      agentType: "agent",
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      access: "personal",
    });
    // Upgrade writers must accept historical documents before normalization.
    await db.transaction(async (tx) => {
      await ResourcePermissionPolicyModel.updatePresetUpgradePolicy({
        tx,
        policy: {
          organizationId: ctx.organizationId,
          resource: "agent",
          scope: agent.id,
        },
        grants: [
          {
            subject: { type: "user", id: ctx.user.id },
            actions: ["read", "retired-action"],
          },
        ] as ResourcePermissionGrant[],
      });
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/resource-permissions",
    });
    expect(response.statusCode, response.body).toBe(200);
    const capabilities = response.json();
    expect(capabilities).toContainEqual({
      organizationId: ctx.organizationId,
      resource: "agent",
      scope: agent.id,
      action: "read",
    });
    expect(
      capabilities.some(
        (grant: { action: string }) => grant.action === "retired-action",
      ),
    ).toBe(false);
    expect(
      capabilities.some(
        (grant: { scope: string; action: string }) =>
          grant.scope === agent.id && grant.action === "use",
      ),
    ).toBe(false);
  });
});
