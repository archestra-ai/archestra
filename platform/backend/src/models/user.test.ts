import { MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import MemberModel from "./member";
import UserModel from "./user";

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
