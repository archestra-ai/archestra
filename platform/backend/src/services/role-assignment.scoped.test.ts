// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import {
  validateInheritedTeamRoles,
  validateNewTeamMembership,
  validateTeamRoles,
} from "./role-assignment";

describe("scoped grant delegation through assignments", () => {
  test("a team's membership admin can add members without permission to edit the team's resources", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const caller = await makeUser();
    await makeMember(caller.id, org.id);
    const team = await makeTeam(org.id, caller.id);
    await makeTeamMember(team.id, caller.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "personal",
    });
    await replacePolicy({
      organizationId: org.id,
      resource: "agent",
      scope: agent.id,
      revision: 0,
      grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
    });
    const context = {
      teamId: team.id,
      organizationId: org.id,
      userId: caller.id,
    };
    await expect(validateNewTeamMembership(context)).resolves.toBeUndefined();
    await expect(validateInheritedTeamRoles(context)).rejects.toThrow(
      "scoped permissions",
    );
  });

  test("requires both the granted action and permission management when assigning a role", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const caller = await makeUser();
    const callerRole = await makeCustomRole(org.id, {
      role: "assigner",
      permission: {},
    });
    const targetRole = await makeCustomRole(org.id, {
      role: "scoped_reader",
      permission: {},
    });
    await makeMember(caller.id, org.id, { role: callerRole.role });
    const context = {
      organizationId: org.id,
      userId: caller.id,
      roles: [targetRole.role],
    };
    const key = {
      organizationId: org.id,
      resource: "skill" as const,
      scope: "*" as const,
    };
    const roleGrant = {
      subject: { type: "role" as const, id: targetRole.id },
      actions: ["read" as const],
    };
    const callerSubject = { type: "user" as const, id: caller.id };
    await replacePolicy({
      ...key,
      revision: 0,
      grants: [roleGrant],
    });
    await expect(validateTeamRoles(context)).rejects.toThrow(
      "scoped permissions",
    );
    await replacePolicy({
      ...key,
      revision: 1,
      grants: [roleGrant, { subject: callerSubject, actions: ["read"] }],
    });
    await expect(validateTeamRoles(context)).rejects.toThrow(
      "scoped permissions",
    );
    await replacePolicy({
      ...key,
      revision: 2,
      grants: [
        roleGrant,
        { subject: callerSubject, actions: ["manage-permissions"] },
      ],
    });
    await expect(validateTeamRoles(context)).rejects.toThrow(
      "scoped permissions",
    );
    await replacePolicy({
      ...key,
      revision: 3,
      grants: [
        roleGrant,
        { subject: callerSubject, actions: ["read", "manage-permissions"] },
      ],
    });
    await expect(validateTeamRoles(context)).resolves.toBeUndefined();
  });

  test("checks direct grants on ancestor teams even when those teams carry no roles", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const caller = await makeUser();
    const role = await makeCustomRole(org.id, {
      role: "team_assigner",
      permission: {},
    });
    await makeMember(caller.id, org.id, { role: role.role });
    const parent = await TeamModel.create({
      organizationId: org.id,
      name: "Parent",
      createdBy: caller.id,
    });
    const child = await TeamModel.create({
      organizationId: org.id,
      name: "Child",
      createdBy: caller.id,
      parentId: parent.id,
    });
    const key = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: "*" as const,
    };
    await replacePolicy({
      ...key,
      revision: 0,
      grants: [
        { subject: { type: "team", id: parent.id }, actions: ["update"] },
      ],
    });
    const context = {
      organizationId: org.id,
      userId: caller.id,
      teamId: child.id,
    };
    await expect(validateInheritedTeamRoles(context)).rejects.toThrow(
      "scoped permissions",
    );
    await replacePolicy({
      ...key,
      revision: 1,
      grants: [],
    });
    await expect(validateInheritedTeamRoles(context)).resolves.toBeUndefined();
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const policy = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: policy?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
