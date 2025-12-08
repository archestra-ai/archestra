import { ADMIN_ROLE_NAME } from "@shared";
import { predefinedPermissionsMap } from "@shared/access-control.ee";
import { getUserPermissions } from "@/models/user.ee";
import { beforeEach, describe, expect, test } from "@/test";

describe("getUserPermissions", () => {
  let testOrgId: string;
  let testUserId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    testOrgId = org.id;
    testUserId = user.id;
  });

  test("should return permissions for custom role", async ({
    makeCustomRole,
    makeMember,
  }) => {
    // Create a custom role
    const createdRole = await makeCustomRole(testOrgId, {
      role: "custom_role",
      name: "Custom Role",
      permission: { profile: ["read", "create"] },
    });

    // Add user with custom role
    await makeMember(testUserId, testOrgId, { role: createdRole.role });

    const result = await getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({
      profile: ["read", "create"],
    });
  });

  test("should handle multiple member records and return first", async ({
    makeMember,
  }) => {
    // This scenario is unlikely in real app but tests the limit(1) behavior
    // Add user as admin member
    await makeMember(testUserId, testOrgId, { role: ADMIN_ROLE_NAME });

    const result = await getUserPermissions(testUserId, testOrgId);

    // Should get admin permissions (from first/only record)
    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return empty permissions for non-existent user", async () => {
    const nonExistentUserId = crypto.randomUUID();

    const result = await getUserPermissions(nonExistentUserId, testOrgId);

    expect(result).toEqual({});
  });

  test("should return empty permissions for user in wrong organization", async ({
    makeOrganization,
    makeMember,
  }) => {
    // Create member in a different organization
    const wrongOrg = await makeOrganization({ name: "Wrong Organization" });
    await makeMember(testUserId, wrongOrg.id, { role: ADMIN_ROLE_NAME });

    // Try to get permissions for original organization
    const result = await getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({});
  });

  test("should handle custom role that no longer exists", async ({
    makeMember,
  }) => {
    // Add user with custom role that doesn't exist
    await makeMember(testUserId, testOrgId, { role: crypto.randomUUID() });

    const result = await getUserPermissions(testUserId, testOrgId);

    // Should return empty permissions when role doesn't exist
    expect(result).toEqual({});
  });
});
