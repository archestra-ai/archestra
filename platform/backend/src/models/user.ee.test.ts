import { beforeEach, describe, expect, test } from "@/test";
import UserModel from "./user";

describe("UserModel.getUserPermissions", () => {
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

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({
      profile: ["read", "create"],
    });
  });

  test("should handle custom role that no longer exists", async ({
    makeMember,
  }) => {
    // Add user with custom role that doesn't exist
    await makeMember(testUserId, testOrgId, { role: crypto.randomUUID() });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    // Should return empty permissions when role doesn't exist
    expect(result).toEqual({});
  });
});
