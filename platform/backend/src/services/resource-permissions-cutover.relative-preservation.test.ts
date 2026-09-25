// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("snapshots only current relative recipients at the intersection of role, team hierarchy, and object sharing", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeAgent,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const foreignOrg = await makeOrganization();
  const owner = await makeUser();
  await makeMember(owner.id, org.id);
  const customRole = await makeCustomRole(org.id, {
    role: "scoped_reviewer",
    permission: { agent: ["read"] },
  });
  const parent = await makeTeam(org.id, owner.id);
  await TeamModel.update(parent.id, { roles: [customRole.role] });
  const child = await makeTeam(org.id, owner.id, { parentId: parent.id });
  const sibling = await makeTeam(org.id, owner.id);
  const descendant = await makeUser();
  const parentOnly = await makeUser();
  const siblingOnly = await makeUser();
  const crossTeam = await makeUser();
  const roleWithoutTeam = await makeUser();
  const foreignUser = await makeUser();
  const departed = await makeUser();
  for (const user of [
    descendant,
    parentOnly,
    siblingOnly,
    departed,
    crossTeam,
  ]) {
    await makeMember(user.id, org.id);
  }
  await makeMember(roleWithoutTeam.id, org.id, { role: customRole.role });
  await makeMember(foreignUser.id, foreignOrg.id);
  await makeTeamMember(child.id, descendant.id);
  await makeTeamMember(parent.id, parentOnly.id);
  await makeTeamMember(sibling.id, siblingOnly.id);
  await makeTeamMember(parent.id, crossTeam.id);
  await makeTeamMember(sibling.id, crossTeam.id);
  await makeTeamMember(child.id, departed.id);
  await TeamModel.removeMember(child.id, departed.id);
  const account = await ServiceAccountModel.create({
    organizationId: org.id,
    createdBy: owner.id,
    name: "Synthetic conversion automation",
    role: customRole.role,
  });
  const base = { organizationId: org.id, resource: "agent" as const };
  const parentAgent = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  const childAgent = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  const siblingAgent = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  const unshared = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: "personal",
  });
  for (const [agent, team] of [
    [parentAgent, parent],
    [childAgent, child],
    [siblingAgent, sibling],
  ]) {
    const key = { ...base, scope: agent.id };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
    });
  }
  const wildcardKey = { ...base, scope: "*" };
  const wildcard = await ResourcePermissionPolicyModel.find(wildcardKey);
  await ResourcePermissionPolicyModel.replace({
    ...wildcardKey,
    revision: wildcard?.revision ?? 0,
    grants: [
      ...(wildcard?.grants ?? []),
      { subject: { type: "team", id: parent.id }, actions: ["read"] },
    ],
  });
  // This is the persisted pre-upgrade policy. The API rejects these sets and
  // the model widens them to presets, so it is written as raw rows.
  await db.insert(schema.resourcePermissionPoliciesTable).values({
    ...base,
    scope: "teams:*",
    legacySharingMigrated: false,
    grants: [
      { subject: { type: "role", id: customRole.id }, actions: ["update"] },
      { subject: { type: "organization", id: "*" }, actions: ["delete"] },
      {
        subject: { type: "team", id: parent.id },
        actions: ["manage-permissions"],
      },
      { subject: { type: "user", id: descendant.id }, actions: ["use"] },
      { subject: { type: "user", id: roleWithoutTeam.id }, actions: ["use"] },
      { subject: { type: "user", id: foreignUser.id }, actions: ["use"] },
      {
        subject: { type: "serviceAccount", id: account.id },
        actions: ["use", "update"],
      },
    ],
  });
  await runScopedResourcePermissionCutover();
  const allows = (
    userId: string,
    scope: string,
    action: "use" | "update" | "delete" | "manage-permissions",
  ) => ResourcePermissions.allows({ ...base, userId, scope, action });
  for (const scope of [parentAgent.id, childAgent.id]) {
    for (const action of [
      "use",
      "update",
      "delete",
      "manage-permissions",
    ] as const) {
      expect(
        await allows(descendant.id, scope, action),
        `descendant ${scope} ${action}`,
      ).toBe(true);
    }
  }
  for (const action of ["update", "delete", "manage-permissions"] as const) {
    expect(await allows(parentOnly.id, parentAgent.id, action)).toBe(true);
    expect(await allows(parentOnly.id, childAgent.id, action)).toBe(false);
  }
  // The snapshot is update, delete and manage-permissions. No preset holds
  // those without use, so the last pass widens it to Full access.
  expect(await allows(parentOnly.id, parentAgent.id, "use")).toBe(true);
  // A role inherited from one team was usable on a resource shared with
  // another team the same person belonged to.
  expect(await allows(crossTeam.id, siblingAgent.id, "update")).toBe(true);
  expect(
    await allows(crossTeam.id, siblingAgent.id, "manage-permissions"),
  ).toBe(true);
  expect(await allows(siblingOnly.id, siblingAgent.id, "delete")).toBe(true);
  // Delete alone widens to Full access, which includes update.
  expect(await allows(siblingOnly.id, siblingAgent.id, "update")).toBe(true);
  expect(await allows(siblingOnly.id, parentAgent.id, "delete")).toBe(false);
  for (const userId of [
    descendant.id,
    parentOnly.id,
    siblingOnly.id,
    roleWithoutTeam.id,
    foreignUser.id,
    departed.id,
    `service-account:${account.id}`,
  ]) {
    for (const action of [
      "use",
      "update",
      "delete",
      "manage-permissions",
    ] as const) {
      expect(await allows(userId, unshared.id, action)).toBe(false);
    }
  }
  for (const userId of [
    roleWithoutTeam.id,
    foreignUser.id,
    departed.id,
    `service-account:${account.id}`,
  ]) {
    for (const scope of [parentAgent.id, childAgent.id, siblingAgent.id]) {
      for (const action of [
        "use",
        "update",
        "delete",
        "manage-permissions",
      ] as const) {
        expect(await allows(userId, scope, action)).toBe(false);
      }
    }
  }
  // Users receive explicit grants, so the snapshot no longer depends on a
  // role assignment or membership after conversion.
  await TeamModel.removeMember(child.id, descendant.id);
  expect(await allows(descendant.id, childAgent.id, "update")).toBe(true);
  const newcomer = await makeUser();
  await makeMember(newcomer.id, org.id);
  await makeTeamMember(child.id, newcomer.id);
  expect(await allows(newcomer.id, childAgent.id, "update")).toBe(false);
  const later = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    access: { teams: [parent.id] },
  });
  expect(await allows(parentOnly.id, later.id, "update")).toBe(false);
  const revokedKey = { ...base, scope: childAgent.id };
  const current = await ResourcePermissionPolicyModel.find(revokedKey);
  await ResourcePermissionPolicyModel.replace({
    ...revokedKey,
    revision: current?.revision ?? 0,
    grants: (current?.grants ?? []).filter(
      (grant) =>
        grant.subject.type !== "user" || grant.subject.id !== descendant.id,
    ),
  });
  await runScopedResourcePermissionCutover();
  expect(await allows(descendant.id, childAgent.id, "update")).toBe(false);
  expect(await allows(newcomer.id, childAgent.id, "update")).toBe(false);
  expect(await allows(parentOnly.id, later.id, "update")).toBe(false);
});
