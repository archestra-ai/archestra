import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import ServiceAccountModel from "@/models/service-account";
import { describe, expect, test } from "@/test";
import { getSkillPermissionChecker } from "./skill-permissions";

describe("getSkillPermissionChecker", () => {
  test("admin role gets canRead, canExecute, isAdmin", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const checker = await getSkillPermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.canRead).toBe(true);
    expect(checker.canExecute).toBe(true);
    expect(checker.isAdmin).toBe(true);
  });

  test("member role gets canRead and canExecute (but not isAdmin) by default", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

    const checker = await getSkillPermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.canRead).toBe(true);
    expect(checker.canExecute).toBe(true);
    expect(checker.isAdmin).toBe(false);
  });

  test("custom role with skill:read but no skill:execute is denied execute", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      role: "reader_only",
      permission: { skill: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    const checker = await getSkillPermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.canRead).toBe(true);
    expect(checker.canExecute).toBe(false);
  });

  test("custom role with skill:read AND skill:execute can execute", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeCustomRole,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      role: "reader_executor",
      permission: { skill: ["read", "execute"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    const checker = await getSkillPermissionChecker({
      userId: user.id,
      organizationId: org.id,
    });

    expect(checker.canRead).toBe(true);
    expect(checker.canExecute).toBe(true);
  });

  test("service-account synthetic user id resolves the account's role permissions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const sa = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "ci-bot",
      role: ADMIN_ROLE_NAME,
    });

    const checker = await getSkillPermissionChecker({
      userId: `service-account:${sa.id}`,
      organizationId: org.id,
    });

    // Before the fix this returned an empty permission set (all false) because
    // the synthetic service-account id has no member row.
    expect(checker.canRead).toBe(true);
    expect(checker.canExecute).toBe(true);
    expect(checker.isAdmin).toBe(true);
  });
});
