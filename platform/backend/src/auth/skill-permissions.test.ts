import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
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

  test("member role gets canRead but NOT canExecute by default", async ({
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
    expect(checker.canExecute).toBe(false);
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
});
