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

      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.userId).toBe(user.id);
      expect(member?.organizationId).toBe(org.id);
    });

    test("should return undefined when user is not a member of specified org", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeUndefined();
    });

    test("should return correct member when user is in multiple orgs", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeMember(user.id, org1.id, { role: "admin" });
      await makeMember(user.id, org2.id, { role: "member" });

      const member1 = await MemberModel.getByUserId(user.id, org1.id);
      const member2 = await MemberModel.getByUserId(user.id, org2.id);

      expect(member1?.role).toBe("admin");
      expect(member2?.role).toBe("member");
    });
  });

  describe("updateRole", () => {
    test("should update member role from member to admin", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const updated = await MemberModel.updateRole(
        user.id,
        org.id,
        ADMIN_ROLE_NAME,
      );

      expect(updated).toBeDefined();
      expect(updated?.role).toBe(ADMIN_ROLE_NAME);
      expect(updated?.userId).toBe(user.id);
      expect(updated?.organizationId).toBe(org.id);
    });

    test("should update member role from admin to member", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

      const updated = await MemberModel.updateRole(
        user.id,
        org.id,
        MEMBER_ROLE_NAME,
      );

      expect(updated).toBeDefined();
      expect(updated?.role).toBe(MEMBER_ROLE_NAME);
    });

    test("should return undefined when user is not a member of organization", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const updated = await MemberModel.updateRole(
        user.id,
        org.id,
        ADMIN_ROLE_NAME,
      );

      expect(updated).toBeUndefined();
    });

    test("should only update the specified user's role in the organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const org = await makeOrganization();
      await makeMember(user1.id, org.id, { role: MEMBER_ROLE_NAME });
      await makeMember(user2.id, org.id, { role: MEMBER_ROLE_NAME });

      await MemberModel.updateRole(user1.id, org.id, ADMIN_ROLE_NAME);

      // Verify user1 was updated
      const member1 = await MemberModel.getByUserId(user1.id, org.id);
      expect(member1?.role).toBe(ADMIN_ROLE_NAME);

      // Verify user2 was not affected
      const member2 = await MemberModel.getByUserId(user2.id, org.id);
      expect(member2?.role).toBe(MEMBER_ROLE_NAME);
    });

    test("should only update role in specified organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeMember(user.id, org1.id, { role: MEMBER_ROLE_NAME });
      await makeMember(user.id, org2.id, { role: MEMBER_ROLE_NAME });

      await MemberModel.updateRole(user.id, org1.id, ADMIN_ROLE_NAME);

      // Verify org1 membership was updated
      const member1 = await MemberModel.getByUserId(user.id, org1.id);
      expect(member1?.role).toBe(ADMIN_ROLE_NAME);

      // Verify org2 membership was not affected
      const member2 = await MemberModel.getByUserId(user.id, org2.id);
      expect(member2?.role).toBe(MEMBER_ROLE_NAME);
    });

    test("should handle updating to custom role name", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const customRole = "editor";
      const updated = await MemberModel.updateRole(user.id, org.id, customRole);

      expect(updated).toBeDefined();
      expect(updated?.role).toBe(customRole);
    });
  });
});
