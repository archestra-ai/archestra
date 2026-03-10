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

  describe("findAllPaginatedByOrganization", () => {
    test("should return paginated members for organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ name: "Alice" });
      const user2 = await makeUser({ name: "Bob" });
      const user3 = await makeUser({ name: "Charlie" });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);
      await makeMember(user3.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 2, offset: 0 },
        sorting: { sortDirection: "asc" },
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.hasNext).toBe(true);
      expect(result.pagination.hasPrev).toBe(false);
    });

    test("should search members by name case-insensitively", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ name: "Alice Johnson" });
      const user2 = await makeUser({ name: "Bob Smith" });
      const user3 = await makeUser({ name: "Charlie Johnson" });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);
      await makeMember(user3.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "johnson",
      });

      expect(result.data).toHaveLength(2);
      const names = result.data.map((m) => m.name);
      expect(names).toContain("Alice Johnson");
      expect(names).toContain("Charlie Johnson");
    });

    test("should search members by email case-insensitively", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ email: "alice@example.com" });
      const user2 = await makeUser({ email: "bob@different.com" });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "EXAMPLE.COM",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe("alice@example.com");
    });

    test("should filter members by role", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const admin = await makeUser({ name: "Admin User" });
      const member1 = await makeUser({ name: "Member One" });
      const member2 = await makeUser({ name: "Member Two" });
      await makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });
      await makeMember(member1.id, org.id, { role: MEMBER_ROLE_NAME });
      await makeMember(member2.id, org.id, { role: MEMBER_ROLE_NAME });

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        role: ADMIN_ROLE_NAME,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].role).toBe(ADMIN_ROLE_NAME);
    });

    test("should filter members by team", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser({ name: "Alice" });
      const user2 = await makeUser({ name: "Bob" });
      const user3 = await makeUser({ name: "Charlie" });
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);
      await makeMember(user3.id, org.id);

      const team = await makeTeam(org.id, user1.id, {
        name: "Engineering",
      });
      await makeTeamMember(team.id, user1.id);
      await makeTeamMember(team.id, user2.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        teamIds: [team.id],
      });

      expect(result.data).toHaveLength(2);
      const names = result.data.map((m) => m.name);
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    });

    test("should sort members by name ascending", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const userC = await makeUser({ name: "Charlie" });
      const userA = await makeUser({ name: "Alice" });
      const userB = await makeUser({ name: "Bob" });
      await makeMember(userC.id, org.id);
      await makeMember(userA.id, org.id);
      await makeMember(userB.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "asc" },
      });

      expect(result.data[0].name).toBe("Alice");
      expect(result.data[1].name).toBe("Bob");
      expect(result.data[2].name).toBe("Charlie");
    });

    test("should sort members by email descending", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const userA = await makeUser({ email: "alice@test.com" });
      const userZ = await makeUser({ email: "zara@test.com" });
      const userM = await makeUser({ email: "mike@test.com" });
      await makeMember(userA.id, org.id);
      await makeMember(userZ.id, org.id);
      await makeMember(userM.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "email", sortDirection: "desc" },
      });

      expect(result.data[0].email).toBe("zara@test.com");
      expect(result.data[1].email).toBe("mike@test.com");
      expect(result.data[2].email).toBe("alice@test.com");
    });

    test("should sort members by role", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const member = await makeUser({ name: "Member User" });
      const admin = await makeUser({ name: "Admin User" });
      await makeMember(member.id, org.id, { role: MEMBER_ROLE_NAME });
      await makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "role", sortDirection: "asc" },
      });

      expect(result.data[0].role).toBe(ADMIN_ROLE_NAME);
      expect(result.data[1].role).toBe(MEMBER_ROLE_NAME);
    });

    test("should return correct team membership data", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ name: "Alice" });
      await makeMember(user.id, org.id);

      const team1 = await makeTeam(org.id, user.id, { name: "Engineering" });
      const team2 = await makeTeam(org.id, user.id, { name: "Design" });
      await makeTeamMember(team1.id, user.id);
      await makeTeamMember(team2.id, user.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].teams).toHaveLength(2);
      const teamNames = result.data[0].teams.map((t) => t.name).sort();
      expect(teamNames).toEqual(["Design", "Engineering"]);
    });

    test("should return isPendingSignup true for users without accounts", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      // makeUser creates a user WITHOUT an account record by default
      const pendingUser = await makeUser({ name: "Pending User" });
      await makeMember(pendingUser.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].isPendingSignup).toBe(true);
    });

    test("should return isPendingSignup false for users with accounts", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
    }) => {
      const org = await makeOrganization();
      const activeUser = await makeUser({ name: "Active User" });
      await makeMember(activeUser.id, org.id);
      await makeAccount(activeUser.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].isPendingSignup).toBe(false);
    });

    test("should handle second page correctly", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user1 = await makeUser();
      const user2 = await makeUser();
      const user3 = await makeUser();
      await makeMember(user1.id, org.id);
      await makeMember(user2.id, org.id);
      await makeMember(user3.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 2, offset: 2 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.hasNext).toBe(false);
      expect(result.pagination.hasPrev).toBe(true);
    });

    test("should not return members from other organizations", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const user1 = await makeUser({ name: "Org1 User" });
      const user2 = await makeUser({ name: "Org2 User" });
      await makeMember(user1.id, org1.id);
      await makeMember(user2.id, org2.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org1.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("Org1 User");
    });

    test("should return empty when search matches nothing", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ name: "Alice" });
      await makeMember(user.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "nonexistent",
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });

    test("should return members with empty teams array when not in any team", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ name: "Teamless User" });
      await makeMember(user.id, org.id);

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].teams).toEqual([]);
    });

    test("should combine search and role filter", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const adminAlice = await makeUser({ name: "Alice Admin" });
      const memberAlice = await makeUser({ name: "Alice Member" });
      const adminBob = await makeUser({ name: "Bob Admin" });
      await makeMember(adminAlice.id, org.id, { role: ADMIN_ROLE_NAME });
      await makeMember(memberAlice.id, org.id, { role: MEMBER_ROLE_NAME });
      await makeMember(adminBob.id, org.id, { role: ADMIN_ROLE_NAME });

      const result = await MemberModel.findAllPaginatedByOrganization({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "Alice",
        role: ADMIN_ROLE_NAME,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("Alice Admin");
      expect(result.data[0].role).toBe(ADMIN_ROLE_NAME);
    });
  });
});
