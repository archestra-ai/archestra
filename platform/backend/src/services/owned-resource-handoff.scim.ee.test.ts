// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { AgentModel, UserModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { scimProvisioningService } from "./scim-provisioning.ee";

describe("SCIM deactivation and a departing member's shared resources", () => {
  test("SCIM deactivation hands shared resources to the longest-standing active admin", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const deactivatedAdmin = await makeUser();
    const senior = await makeUser();
    const junior = await makeUser();
    const departing = await makeUser();
    await makeMember(deactivatedAdmin.id, organization.id, {
      role: ADMIN_ROLE_NAME,
      createdAt: new Date("2024-01-01"),
    });
    await makeMember(senior.id, organization.id, {
      role: `editor,${ADMIN_ROLE_NAME}`,
      createdAt: new Date("2024-02-01"),
    });
    await makeMember(junior.id, organization.id, {
      role: ADMIN_ROLE_NAME,
      createdAt: new Date("2024-03-01"),
    });
    await makeMember(departing.id, organization.id, {
      role: ADMIN_ROLE_NAME,
      createdAt: new Date("2023-01-01"),
    });
    await UserModel.setSoftDeleted({
      userId: deactivatedAdmin.id,
      softDeleted: new Date(),
    });
    const team = await makeTeam(organization.id, senior.id);
    const teamAgent = await makeAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { teams: [team.id] },
    });

    await scimProvisioningService.softDeleteUser({
      organizationId: organization.id,
      userId: departing.id,
    });

    expect((await AgentModel.findById(teamAgent.id))?.authorId).toBe(senior.id);
    // The deactivated user keeps their own grant, so a restore gives back access.
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: organization.id,
      resource: "agent",
      scope: teamAgent.id,
    });
    expect(
      policy?.grants.some(
        (grant) =>
          grant.subject.type === "user" && grant.subject.id === departing.id,
      ),
    ).toBe(true);
  });
});
