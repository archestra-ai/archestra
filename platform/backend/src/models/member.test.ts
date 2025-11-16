import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import MemberModel from "./member";

describe("MemberModel", () => {
  describe("create", () => {
    test("should create member with member role", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const result = await MemberModel.create(
        user.id,
        org.id,
        MEMBER_ROLE_NAME,
      );

      expect(result).toHaveLength(1);
      const member = result[0];
      expect(member?.id).toBeDefined();
      expect(member?.userId).toBe(user.id);
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);
      expect(member?.createdAt).toBeInstanceOf(Date);
    });

    test("should create member with admin role", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const result = await MemberModel.create(user.id, org.id, ADMIN_ROLE_NAME);

      expect(result).toHaveLength(1);
      const member = result[0];
      expect(member?.role).toBe(ADMIN_ROLE_NAME);
    });

    test("should allow same user to be member of multiple organizations", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const result1 = await MemberModel.create(
        user.id,
        org1.id,
        MEMBER_ROLE_NAME,
      );
      const result2 = await MemberModel.create(
        user.id,
        org2.id,
        ADMIN_ROLE_NAME,
      );

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result1[0]?.organizationId).toBe(org1.id);
      expect(result2[0]?.organizationId).toBe(org2.id);
      expect(result1[0]?.role).toBe(MEMBER_ROLE_NAME);
      expect(result2[0]?.role).toBe(ADMIN_ROLE_NAME);
    });
  });

  describe("getByUserId", () => {
    test("should return member for user in organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id);

      const member = await MemberModel.getByUserId(user.id);
      expect(member).toBeDefined();
      expect(member?.userId).toBe(user.id);
      expect(member?.organizationId).toBe(org.id);
    });

    test("should return undefined when user is not a member", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const member = await MemberModel.getByUserId(user.id);
      expect(member).toBeUndefined();
    });
  });

  describe("getByUserAndOrganization", () => {
    test("should return member when user belongs to organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(org.id, user.id, { role: "admin" });

      const member = await MemberModel.getByUserAndOrganization(
        user.id,
        org.id,
      );
      expect(member).toBeDefined();
      expect(member?.userId).toBe(user.id);
      expect(member?.organizationId).toBe(org.id);
      expect(member?.role).toBe("admin");
    });

    test("should return undefined when user is not a member of specific organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      // User is member of org1 but not org2
      await makeMember(org1.id, user.id, { role: "member" });

      const member = await MemberModel.getByUserAndOrganization(
        user.id,
        org2.id,
      );
      expect(member).toBeUndefined();
    });

    test("should return undefined when user doesn't exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const nonExistentUserId = crypto.randomUUID();

      const member = await MemberModel.getByUserAndOrganization(
        nonExistentUserId,
        org.id,
      );
      expect(member).toBeUndefined();
    });

    test("should return undefined when organization doesn't exist", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const nonExistentOrgId = crypto.randomUUID();

      const member = await MemberModel.getByUserAndOrganization(
        user.id,
        nonExistentOrgId,
      );
      expect(member).toBeUndefined();
    });
  });
});
