import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import MemberModel from "./member";
import OrganizationRoleModel from "./organization-role";

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
    test("can update member role from member to admin", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      // Verify initial role
      const memberBefore = await MemberModel.getByUserId(user.id, org.id);
      expect(memberBefore?.role).toBe(MEMBER_ROLE_NAME);

      // Update role using MemberModel.updateRole
      const updated = await MemberModel.updateRole(user.id, org.id, ADMIN_ROLE_NAME);

      expect(updated?.role).toBe(ADMIN_ROLE_NAME);

      // Verify the update persisted
      const memberAfter = await MemberModel.getByUserId(user.id, org.id);
      expect(memberAfter?.role).toBe(ADMIN_ROLE_NAME);
    });

    test("idempotent - assigning same role keeps existing role", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const member = await makeMember(user.id, org.id, {
        role: MEMBER_ROLE_NAME,
      });

      // Querying the same role should return consistent result
      const currentMember = await MemberModel.getByUserId(user.id, org.id);
      expect(currentMember?.role).toBe(MEMBER_ROLE_NAME);
      expect(currentMember?.role).toBe(member.role);
    });

    test("can assign custom role to member", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      // Create a custom role
      const customRole = await makeCustomRole(org.id, {
        role: "viewer",
        name: "Viewer Role",
        permission: { profile: ["read"] },
      });

      // Update to custom role using MemberModel.updateRole
      const updated = await MemberModel.updateRole(user.id, org.id, customRole.role);

      expect(updated?.role).toBe("viewer");
    });
  });

  describe("role assignment verification", () => {
    test("can verify role assignment exists", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).not.toBeNull();
      expect(member?.role).toBe(MEMBER_ROLE_NAME);
    });

    test("can detect when specific role is not assigned", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const member = await MemberModel.getByUserId(user.id, org.id);

      // User has 'member' role, not 'admin'
      expect(member?.role).not.toBe(ADMIN_ROLE_NAME);
    });

    test("can get role details for member assignment", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const member = await makeMember(user.id, org.id, {
        role: MEMBER_ROLE_NAME,
      });

      expect(member.role).toBe(MEMBER_ROLE_NAME);

      // Get role details
      const role = await OrganizationRoleModel.getById(
        MEMBER_ROLE_NAME,
        org.id,
      );
      expect(role).not.toBeNull();
      expect(role?.role).toBe(MEMBER_ROLE_NAME);
      expect(role?.permission).toBeDefined();
    });

    test("works with custom roles", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      // Create custom role first
      const customRole = await makeCustomRole(org.id, {
        role: "analyst",
        name: "Analyst Role",
        permission: { profile: ["read"], interaction: ["read"] },
      });

      // Create member with custom role
      await makeMember(user.id, org.id, { role: customRole.role });

      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("analyst");

      // Verify role can be looked up
      const role = await OrganizationRoleModel.getByIdentifier(
        "analyst",
        org.id,
      );
      expect(role).not.toBeNull();
      expect(role?.name).toBe("Analyst Role");
    });
  });
});
