// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";

describe("resource permissions", () => {
  test("sharing with a team cannot activate relative edit authority the grantor does not hold", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const team = await makeTeam(org.id, user.id);
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: "733dfe40-c090-490c-ab19-b9935c3c4bf2",
    };
    await replacePolicy({
      ...context,
      scope: "teams:*",
      revision: 0,
      grants: [
        { subject: { type: "role", id: "editor" }, actions: ["update"] },
      ],
    });
    const request = {
      ...context,
      revision: 0,
      grants: [
        {
          subject: { type: "team" as const, id: team.id },
          actions: ["read" as const],
        },
      ],
      authority: [
        { ...context, action: "read" as const },
        { ...context, action: "manage-permissions" as const },
      ],
    };
    await expect(ResourcePermissions.replace(request)).rejects.toThrow(
      "only grant permissions you hold",
    );
    expect(await ResourcePermissionPolicyModel.find(context)).toBeNull();
    await ResourcePermissions.replace({
      ...request,
      authority: [...request.authority, { ...context, action: "update" }],
    });
    expect((await ResourcePermissionPolicyModel.find(context))?.grants).toEqual(
      request.grants,
    );
  });
  test("service accounts receive exact and wildcard grants, and disabled or foreign accounts cannot use them", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const account = await ServiceAccountModel.create({
      createdBy: null,
      organizationId: org.id,
      name: "Release automation",
      role: "member",
    });
    const context = {
      organizationId: org.id,
      userId: `service-account:${account.id}`,
      resource: "mcpRegistry" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const subject = { type: "serviceAccount" as const, id: account.id };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject, actions: ["update"] }],
    });
    await replacePolicy({
      ...context,
      scope: "*",
      revision: 0,
      grants: [{ subject, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({
        ...context,
        scope: "00000000-0000-4000-8000-000000000002",
        action: "update",
      }),
    ).toBe(false);
    expect(
      await ResourcePermissions.allows({
        ...context,
        scope: "00000000-0000-4000-8000-000000000002",
        action: "read",
      }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({
        ...context,
        organizationId: other.id,
        action: "read",
      }),
    ).toBe(false);
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        grants: [{ subject, actions: ["read"] }],
      }),
    ).rejects.toThrow("disabled");
  });
  test("inherits grants down the team hierarchy and revokes them when membership ends", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const creator = await makeUser();
    await makeMember(user.id, org.id);
    const parent = await TeamModel.create({
      name: "Engineering",
      organizationId: org.id,
      createdBy: creator.id,
    });
    const child = await TeamModel.create({
      name: "Frontend",
      organizationId: org.id,
      createdBy: creator.id,
      parentId: parent.id,
    });
    await TeamModel.addMember(child.id, user.id);
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject: { type: "team", id: parent.id }, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(false);
    await TeamModel.removeMember(child.id, user.id);
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
  });

  test("an organization grant never grants access to nonmembers", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, otherOrg.id);
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["read"] },
      ],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(false);
    await makeMember(user.id, org.id);
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
  });

  test("role recipients follow inherited assignments using immutable role ids", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      role: "resource_reader",
      permission: {},
    });
    await makeMember(user.id, org.id, { role: role.role });
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "skill" as const,
      scope: "*" as const,
    };
    await replacePolicy({
      ...context,
      revision: 0,
      grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
    });
    expect(
      await ResourcePermissions.allows({ ...context, action: "read" }),
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...context, action: "delete" }),
    ).toBe(false);
  });

  test("rejects foreign recipients and rejects delegation beyond the caller's scope", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, other.id);
    const key = {
      organizationId: org.id,
      userId: user.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const grant = {
      subject: { type: "user" as const, id: user.id },
      actions: ["read" as const],
    };
    await expect(
      ResourcePermissions.validateRecipients({
        organizationId: org.id,
        grants: [grant],
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      ResourcePermissions.replace({
        ...key,
        revision: 0,
        grants: [grant],
        authority: [{ ...key, action: "manage-permissions" }],
      }),
    ).rejects.toThrow("only grant permissions you hold");
    expect(await ResourcePermissionPolicyModel.find(key)).toBeNull();
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const current = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: current?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
