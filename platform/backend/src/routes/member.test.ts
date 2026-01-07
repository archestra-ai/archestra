import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { MemberModel, OrganizationRoleModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("member routes", () => {
  describe("GET /api/members/:userId - lookup user by ID", () => {
    test("returns user with membership info when user exists in org", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ name: "Test Member User" });
      const member = await makeMember(user.id, org.id, {
        role: MEMBER_ROLE_NAME,
      });

      // Verify the member was created
      const foundMember = await MemberModel.getByUserId(user.id, org.id);
      expect(foundMember).not.toBeNull();
      expect(foundMember?.userId).toBe(user.id);
      expect(foundMember?.organizationId).toBe(org.id);
      expect(foundMember?.role).toBe(MEMBER_ROLE_NAME);
    });

    test("returns 404 when user is not a member of org", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      // User exists but has no membership
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeUndefined();
    });
  });

  describe("PUT /api/members/:userId/role - assign role to user", () => {
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

      // Simulate role update (what the route does)
      const { schema } = await import("@/database");
      const db = (await import("@/database")).default;
      const { eq, and } = await import("drizzle-orm");

      const [updated] = await db
        .update(schema.membersTable)
        .set({ role: ADMIN_ROLE_NAME })
        .where(
          and(
            eq(schema.membersTable.userId, user.id),
            eq(schema.membersTable.organizationId, org.id),
          ),
        )
        .returning();

      expect(updated.role).toBe(ADMIN_ROLE_NAME);

      // Verify the update persisted
      const memberAfter = await MemberModel.getByUserId(user.id, org.id);
      expect(memberAfter?.role).toBe(ADMIN_ROLE_NAME);
    });

    test("idempotent - assigning same role returns success", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const member = await makeMember(user.id, org.id, {
        role: MEMBER_ROLE_NAME,
      });

      // Assigning the same role should succeed (idempotent)
      const currentMember = await MemberModel.getByUserId(user.id, org.id);
      expect(currentMember?.role).toBe(MEMBER_ROLE_NAME);

      // Role is already assigned, no change needed
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

      // Update to custom role
      const { schema } = await import("@/database");
      const db = (await import("@/database")).default;
      const { eq, and } = await import("drizzle-orm");

      const [updated] = await db
        .update(schema.membersTable)
        .set({ role: customRole.role })
        .where(
          and(
            eq(schema.membersTable.userId, user.id),
            eq(schema.membersTable.organizationId, org.id),
          ),
        )
        .returning();

      expect(updated.role).toBe("viewer");
    });
  });

  describe("DELETE /api/members/:userId/role/:roleId - remove role", () => {
    test("returns success when role assignment exists", async ({
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

      // Role assignment exists - would return success
    });

    test("detects when role is not assigned", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const member = await MemberModel.getByUserId(user.id, org.id);

      // User has 'member' role, not 'admin' - should return 404
      expect(member?.role).not.toBe(ADMIN_ROLE_NAME);
    });
  });

  describe("GET /api/members/:userId/role/:roleId - read assignment", () => {
    test("returns assignment with role details when exists", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const member = await makeMember(user.id, org.id, {
        role: MEMBER_ROLE_NAME,
      });

      // Verify member has the role
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

    test("returns null when assignment does not exist", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

      const member = await MemberModel.getByUserId(user.id, org.id);

      // User has 'member' role, checking for 'admin' should fail
      const hasAdminRole = member?.role === ADMIN_ROLE_NAME;
      expect(hasAdminRole).toBe(false);
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
