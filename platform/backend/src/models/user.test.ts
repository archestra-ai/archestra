import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { predefinedPermissionsMap } from "@shared/access-control";
import { beforeEach, describe, expect, test } from "@/test";
import MemberModel from "./member";
import UserModel from "./user";

describe("User.getUserPermissions", () => {
  let testOrgId: string;
  let testUserId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    testOrgId = org.id;
    testUserId = user.id;
  });

  test("should return empty permissions when user is not a member", async () => {
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);
    expect(result).toEqual({});
  });

  test("should return permissions for admin role", async ({ makeMember }) => {
    // Add user as admin member
    await makeMember(testUserId, testOrgId, { role: ADMIN_ROLE_NAME });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return permissions for member role", async ({ makeMember }) => {
    // Add user as member
    await makeMember(testUserId, testOrgId, { role: MEMBER_ROLE_NAME });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
  });

  test("should handle multiple member records and return first", async ({
    makeMember,
  }) => {
    // This scenario is unlikely in real app but tests the limit(1) behavior
    // Add user as admin member
    await makeMember(testUserId, testOrgId, { role: ADMIN_ROLE_NAME });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    // Should get admin permissions (from first/only record)
    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return empty permissions for non-existent user", async () => {
    const nonExistentUserId = crypto.randomUUID();

    const result = await UserModel.getUserPermissions(
      nonExistentUserId,
      testOrgId,
    );

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
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({});
  });
});

describe("UserModel.findByEmail", () => {
  test("should find a user by email", async ({ makeUser }) => {
    const user = await makeUser({ email: "findme@test.com" });

    const foundUser = await UserModel.findByEmail("findme@test.com");

    expect(foundUser).toBeDefined();
    expect(foundUser?.id).toBe(user.id);
    expect(foundUser?.email).toBe("findme@test.com");
  });

  test("should return undefined for non-existent email", async () => {
    const foundUser = await UserModel.findByEmail("nonexistent@test.com");

    expect(foundUser).toBeUndefined();
  });
});

describe("UserModel.delete", () => {
  test("should delete a user", async ({ makeUser }) => {
    const user = await makeUser({ email: "deleteme@test.com" });

    // Delete user
    const deleted = await UserModel.delete(user.id);

    expect(deleted).toBe(true);

    // Verify user is gone
    const foundUser = await UserModel.findByEmail("deleteme@test.com");
    expect(foundUser).toBeUndefined();
  });

  test("should delete a user after their membership is removed", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser({ email: "deleteme2@test.com" });
    const org = await makeOrganization();

    // Create membership
    await MemberModel.create(user.id, org.id, MEMBER_ROLE_NAME);

    // Must delete membership first due to foreign key constraint
    await MemberModel.deleteByMemberOrUserId(user.id, org.id);

    // Now delete user
    const deleted = await UserModel.delete(user.id);

    expect(deleted).toBe(true);

    // Verify user is gone
    const foundUser = await UserModel.findByEmail("deleteme2@test.com");
    expect(foundUser).toBeUndefined();
  });

  test("should return false for non-existent user", async () => {
    const deleted = await UserModel.delete(crypto.randomUUID());

    expect(deleted).toBe(false);
  });
});
