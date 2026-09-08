import { describe, expect } from "vitest";
import { isGlobalAdmin } from "@/auth/utils";
import {
  OrganizationRoleModel,
  ServiceAccountModel,
  TeamModel,
  UserModel,
} from "@/models";
import { test } from "@/test";
import RoleCompositionModel from "./role-composition";

describe("role composition", () => {
  test("unions direct and inherited roles, reports sources, and revokes removed grants immediately", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const creator = await makeUser();
    const readRole = await makeCustomRole(org.id, {
      role: "audit_reader",
      permission: { log: ["read"] },
    });
    const writeRole = await makeCustomRole(org.id, {
      role: "tool_editor",
      permission: { agent: ["update"] },
    });
    const teamRole = await makeCustomRole(org.id, {
      role: "team_reader",
      permission: { team: ["read"] },
    });
    await makeMember(user.id, org.id, {
      role: `${readRole.role},${writeRole.role}`,
    });
    const parent = await TeamModel.create({
      name: "Operations",
      organizationId: org.id,
      createdBy: creator.id,
      roles: [teamRole.role],
    });
    const child = await TeamModel.create({
      name: "Support",
      organizationId: org.id,
      createdBy: creator.id,
      parentId: parent.id,
    });
    await TeamModel.addMember(child.id, user.id);
    expect(await UserModel.getUserPermissions(user.id, org.id)).toEqual({
      log: ["read"],
      agent: ["update"],
      team: ["read"],
    });
    expect(
      await RoleCompositionModel.getUserSources({
        userId: user.id,
        organizationId: org.id,
      }),
    ).toContainEqual({
      role: teamRole.role,
      team: { id: parent.id, name: "Operations" },
      permissions: { team: ["read"] },
    });
    expect(
      await RoleCompositionModel.getRoleHolders({
        roleIdentifier: teamRole.role,
        organizationId: org.id,
      }),
    ).toEqual([{ userId: user.id }]);
    expect(await isGlobalAdmin(user.id, org.id)).toBe(false);
    await TeamModel.update(parent.id, { roles: ["admin"] });
    expect(await isGlobalAdmin(user.id, org.id)).toBe(true);
    await TeamModel.update(parent.id, { roles: [] });
    expect(await UserModel.getUserPermissions(user.id, org.id)).toEqual({
      log: ["read"],
      agent: ["update"],
    });
    await TeamModel.update(parent.id, { roles: [teamRole.role] });
    await TeamModel.removeMember(child.id, user.id);
    expect(
      (await UserModel.getUserPermissions(user.id, org.id)).team,
    ).toBeUndefined();
  });

  test("does not inherit grants without organization membership or across organizations", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(other.id, {
      role: "private_reader",
      permission: { log: ["read"] },
    });
    const team = await TeamModel.create({
      name: "Private",
      organizationId: other.id,
      createdBy: user.id,
      roles: [role.role],
    });
    expect(team.roles).toEqual([role.role]);
    expect(await UserModel.getUserPermissions(user.id, other.id)).toEqual({});
    await makeMember(user.id, org.id, { role: "missing_role" });
    expect(await UserModel.getUserPermissions(user.id, org.id)).toEqual({});
  });

  test("unions service account roles and prevents deleting an assigned component role", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const reader = await makeCustomRole(org.id, {
      role: "log_reader",
      permission: { log: ["read"] },
    });
    const editor = await makeCustomRole(org.id, {
      role: "tool_editor",
      permission: { agent: ["update"] },
    });
    const account = await ServiceAccountModel.create({
      name: "Test automation",
      organizationId: org.id,
      createdBy: user.id,
      role: `${reader.role},${editor.role}`,
    });
    expect(await ServiceAccountModel.getPermissions(account)).toEqual({
      log: ["read"],
      agent: ["update"],
    });
    expect(
      (await OrganizationRoleModel.canDelete(editor.id, org.id)).canDelete,
    ).toBe(false);
  });
});
