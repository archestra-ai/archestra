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

  describe("findByIdOrEmail", () => {
    test("should find member by user ID", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser({ email: "findme@test.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id);

      const result = await MemberModel.findByIdOrEmail(user.id, org.id);
      expect(result).toBeDefined();
      expect(result?.id).toBe(user.id);
      expect(result?.email).toBe("findme@test.com");
      expect(result?.role).toBe("member");
    });

    test("should find member by email", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser({ email: "byemail@test.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id);

      const result = await MemberModel.findByIdOrEmail(
        "byemail@test.com",
        org.id,
      );
      expect(result).toBeDefined();
      expect(result?.id).toBe(user.id);
      expect(result?.email).toBe("byemail@test.com");
      expect(result?.role).toBe("member");
    });

    test("should return undefined for non-existent user", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await MemberModel.findByIdOrEmail(
        "nonexistent@test.com",
        org.id,
      );
      expect(result).toBeUndefined();
    });

    test("should not find member from different organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser({ email: "orgscoped@test.com" });
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeMember(user.id, org1.id);

      const result = await MemberModel.findByIdOrEmail(user.id, org2.id);
      expect(result).toBeUndefined();
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

  describe("findAllPaginated", () => {
    test("returns paginated members with user details", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ name: "Alice", email: "alice@test.com" });
      const user2 = await makeUser({ name: "Bob", email: "bob@test.com" });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.data[0]).toHaveProperty("name");
      expect(result.data[0]).toHaveProperty("email");
      expect(result.data[0]).toHaveProperty("image");
    });

    test("supports offset pagination", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      for (let i = 0; i < 5; i++) {
        const user = await makeUser({ email: `user${i}@test.com` });
        await makeMember(user.id, org.id);
      }

      const page1 = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 2, offset: 0 },
      });
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total).toBe(5);

      const page2 = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 2, offset: 4 },
      });
      expect(page2.data).toHaveLength(1);
      expect(page2.pagination.total).toBe(5);
    });

    test("filters by name (ILIKE on user name)", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const alice = await makeUser({
        name: "Alice Smith",
        email: "a@test.com",
      });
      const bob = await makeUser({ name: "Bob Jones", email: "b@test.com" });
      await makeMember(alice.id, org.id);
      await makeMember(bob.id, org.id);

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
        name: "alice",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("Alice Smith");
    });

    test("filters by name (ILIKE on user email)", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({
        name: "User One",
        email: "alice@example.com",
      });
      const user2 = await makeUser({
        name: "User Two",
        email: "bob@example.com",
      });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
        name: "alice@",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe("alice@example.com");
    });

    test("filters by role", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const member = await makeUser({ email: "member@test.com" });
      const admin = await makeUser({ email: "admin@test.com" });
      await makeMember(member.id, org.id);
      await makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
        role: ADMIN_ROLE_NAME,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].role).toBe(ADMIN_ROLE_NAME);
    });

    test("combines name and role filters", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const u1 = await makeUser({ name: "Alice Admin", email: "aa@test.com" });
      const u2 = await makeUser({ name: "Alice Member", email: "am@test.com" });
      const u3 = await makeUser({ name: "Bob Admin", email: "ba@test.com" });
      await makeMember(u1.id, org.id, { role: ADMIN_ROLE_NAME });
      await makeMember(u2.id, org.id);
      await makeMember(u3.id, org.id, { role: ADMIN_ROLE_NAME });

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
        name: "alice",
        role: ADMIN_ROLE_NAME,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("Alice Admin");
    });

    test("returns empty for org with no members", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await MemberModel.findAllPaginated({
        organizationId: org.id,
        pagination: { limit: 10, offset: 0 },
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });
});
