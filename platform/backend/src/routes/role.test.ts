import { describe, expect, test } from "@/test";
import RoleModel from "@/models/role";
import UserRoleAssignmentModel from "@/models/user-role-assignment";

describe("Role Operations", () => {
  describe("role creation and management", () => {
    test("should create and manage roles", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Editor",
        permissions: ["read", "write"],
      });

      expect(role.name).toBe("Editor");
      expect(role.permissions).toEqual(["read", "write"]);
    });

    test("should list all roles for organization", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await RoleModel.create({
        organizationId: org.id,
        name: "Editor",
        permissions: ["read", "write"],
      });
      await RoleModel.create({
        organizationId: org.id,
        name: "Viewer",
        permissions: ["read"],
      });

      const roles = await RoleModel.findByOrganization(org.id);
      expect(roles.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("role CRUD operations", () => {
    test("should create a new role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Custom Role",
        description: "A custom role",
        permissions: ["read", "write", "delete"],
      });

      expect(role.name).toBe("Custom Role");
      expect(role.permissions).toEqual(["read", "write", "delete"]);
    });

    test("should get a role by ID", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        permissions: ["read"],
      });

      const found = await RoleModel.findById(role.id);
      expect(found?.id).toBe(role.id);
      expect(found?.name).toBe("Test Role");
    });

    test("should get a role by name", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        permissions: ["read"],
      });

      const found = await RoleModel.findByName(org.id, "Test Role");
      expect(found?.name).toBe("Test Role");
    });

    test("should update a role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Original Name",
        permissions: ["read"],
      });

      const updated = await RoleModel.update(role.id, {
        name: "Updated Name",
        permissions: ["read", "write"],
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.permissions).toEqual(["read", "write"]);
    });

    test("should delete a role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Role to Delete",
        permissions: ["read"],
      });

      await RoleModel.delete(role.id);

      const deleted = await RoleModel.findById(role.id);
      expect(deleted).toBeNull();
    });
  });

  describe("role assignments", () => {
    test("should handle role with assignments", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Role with Assignments",
        permissions: ["read"],
      });

      const assignment = await UserRoleAssignmentModel.create({
        userId: user.id,
        roleId: role.id,
      });

      const assignments = await UserRoleAssignmentModel.findByUser(user.id);
      expect(assignments.length).toBeGreaterThan(0);
    });
  });
});
