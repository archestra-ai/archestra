import { describe, expect, test } from "@/test";
import UserRoleAssignmentModel from "@/models/user-role-assignment";
import RoleModel from "@/models/role";

describe("UserRoleAssignmentModel", () => {
  describe("create", () => {
    test("should assign a role to a user", async ({
      makeUser,
      makeOrganization,
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

      expect(assignment).toBeDefined();
      expect(assignment.id).toBeDefined();
      expect(assignment.userId).toBe(user.id);
      expect(assignment.roleId).toBe(role.id);
      expect(assignment.assignedAt).toBeDefined();
    });

    test("should throw error for duplicate assignment", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Duplicate Test",
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
  });

  describe("findByUserAndRole", () => {
    test("should find assignment by user and role", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Find Test",
        permissions: ["read"],
      });

      const created = await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      const found = await UserRoleAssignmentModel.findByUserAndRole(
        user.id,
        role.id,
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    test("should return null for non-existent assignment", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Null Test",
        permissions: ["read"],
      });

      const found = await UserRoleAssignmentModel.findByUserAndRole(
        user.id,
        role.id,
      );

      expect(found).toBeNull();
    });
  });

  describe("findByUser", () => {
    test("should find all roles for a user", async ({
      makeUser,
      makeOrganization,
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

      expect(Array.isArray(assignments)).toBe(true);
      expect(assignments.length).toBe(2);
    });

    test("should return empty array for user with no roles", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const assignments = await UserRoleAssignmentModel.findByUser(user.id);
      expect(assignments).toEqual([]);
    });
  });

  describe("delete", () => {
    test("should delete an assignment", async ({
      makeUser,
      makeOrganization,
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

    test("should throw error for non-existent assignment", async () => {
      await expect(
        UserRoleAssignmentModel.delete("non-existent-id"),
      ).rejects.toThrow();
    });
  });
});
