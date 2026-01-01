import { ADMIN_ROLE_NAME } from "@shared";
import { predefinedPermissionsMap } from "@shared/access-control";
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
});
