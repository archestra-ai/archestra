import { describe, expect, test } from "@/test";
import RoleModel from "@/models/role";
import UserRoleAssignmentModel from "@/models/user-role-assignment";

describe("User Role Assignments", () => {
  describe("role assignment operations", () => {
    test("should assign a role to a user", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        permissions: ["read"],
      });

      const assignment = await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      expect(assignment.userId).toBe(user.id);
      expect(assignment.roleId).toBe(role.id);
    });

    test("should not allow duplicate role assignment", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        permissions: ["read"],
      });

      await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      await expect(
        UserRoleAssignmentModel.create({
          userId: user.id,
          roleId: role.id,
        }),
      ).rejects.toThrow();
    });

    test("should handle user-role assignment with role not found", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      await expect(
        UserRoleAssignmentModel.create({
          userId: user.id,
          roleId: "non-existent-role",
        }),
      ).rejects.toThrow();
    });

    test("should handle user-role assignment with user not found", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        permissions: ["read"],
      });

      await expect(
        UserRoleAssignmentModel.create({
          userId: "non-existent-user",
          roleId: role.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe("role assignment queries", () => {
    test("should get all roles assigned to a user", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role1 = await RoleModel.create({
        organizationId: org.id,
        name: "Role 1",
        permissions: ["read"],
      });

      const role2 = await RoleModel.create({
        organizationId: org.id,
        name: "Role 2",
        permissions: ["write"],
      });

      await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role1.id,
      });

      await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role2.id,
      });

      const assignments = await UserRoleAssignmentModel.findByUser(user.id);
      expect(assignments.length).toBe(2);
    });

    test("should get specific user role assignment", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Specific Role",
        permissions: ["read"],
      });

      await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      const found = await UserRoleAssignmentModel.findByUserAndRole(
        user.id,
        role.id,
      );

      expect(found).toBeDefined();
      expect(found?.userId).toBe(user.id);
      expect(found?.roleId).toBe(role.id);
    });
  });

  describe("role assignment deletion", () => {
    test("should remove role assignment from user", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Delete Test",
        permissions: ["read"],
      });

      const assignment = await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      await UserRoleAssignmentModel.delete(assignment.id);

      const found = await UserRoleAssignmentModel.findByUserAndRole(
        user.id,
        role.id,
      );

      expect(found).toBeNull();
    });

    test("should throw error when deleting non-existent assignment", async () => {
      await expect(
        UserRoleAssignmentModel.delete("non-existent-id"),
      ).rejects.toThrow();
    });
  });
});
