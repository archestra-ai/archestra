// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { PERMISSIONS_LOCKOUT_CODE } from "@archestra/shared";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { ResourcePermissions } from "./resource-permissions";

/**
 * Lowering every recipient of a policy below Full access leaves nobody able
 * to edit, delete, or share what it covers. A save that would do that is
 * refused instead of locking the organization out.
 */
describe("a permissions save that would leave nobody managing", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = true;
  });

  test("lowering every role to Can view on all MCP registry entries is refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    const current = await ResourcePermissionPolicyModel.find(context);

    const error = await ResourcePermissions.updatePolicy({
      ...context,
      revision: current?.revision ?? 0,
      grants: (current?.grants ?? []).map((grant) => ({
        ...grant,
        actions: ["read"],
      })),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).internalCode).toBe(PERMISSIONS_LOCKOUT_CODE);
    const after = await ResourcePermissionPolicyModel.find(context);
    expect(after?.grants).toEqual(current?.grants);
  });

  test("the save succeeds while one recipient keeps Full access", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "agent" as const,
      scope: "*" as const,
    };
    const current = await ResourcePermissionPolicyModel.find(context);

    await expect(
      ResourcePermissions.updatePolicy({
        ...context,
        revision: current?.revision ?? 0,
        grants: [
          {
            subject: { type: "role", id: "admin" },
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
          {
            subject: { type: "role", id: "platform_admin" },
            actions: ["read"],
          },
        ],
      }),
    ).resolves.toMatchObject({ resource: "agent" });
  });

  test("removing an agent's own manager is allowed while Full access on all agents still reaches it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    enterpriseTier.setUserCountForTesting(0);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: admin.id,
      agentType: "agent",
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "agent" as const,
      scope: agent.id,
    };
    const current = await ResourcePermissionPolicyModel.find(context);

    await expect(
      ResourcePermissions.updatePolicy({
        ...context,
        revision: current?.revision ?? 0,
        grants: [],
      }),
    ).resolves.toMatchObject({ scope: agent.id });
  });

  test("the policy response names the caller's own subjects", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });

    const policy = await ResourcePermissions.getPolicy({
      organizationId: org.id,
      userId: admin.id,
      resource: "agent",
      scope: "*",
    });

    expect(policy.actorSubjects).toEqual(
      expect.arrayContaining([
        { type: "user", id: admin.id },
        { type: "role", id: "admin" },
      ]),
    );
  });
});
