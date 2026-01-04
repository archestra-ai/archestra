import { describe, expect, test } from "@/test";
import RoleModel from "@/models/role";

describe("RoleModel", () => {
  describe("create", () => {
    test("should create a new role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Test Role",
        description: "A test role",
        permissions: ["read", "write"],
      });

      expect(role).toBeDefined();
      expect(role.id).toBeDefined();
      expect(role.name).toBe("Test Role");
      expect(role.description).toBe("A test role");
      expect(role.permissions).toEqual(["read", "write"]);
      expect(role.organizationId).toBe(org.id);
    });

    test("should throw error for duplicate role name in organization", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await RoleModel.create({
        organizationId: org.id,
        name: "Duplicate Role",
        permissions: ["read"],
      });

      await expect(
        RoleModel.create({
          organizationId: org.id,
          name: "Duplicate Role",
          permissions: ["write"],
        }),
      ).rejects.toThrow();
    });

    test("should allow roles with same name in different organizations", async ({
      makeOrganization,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const role1 = await RoleModel.create({
        organizationId: org1.id,
        name: "Shared Name",
        permissions: ["read"],
      });

      const role2 = await RoleModel.create({
        organizationId: org2.id,
        name: "Shared Name",
        permissions: ["write"],
      });

      expect(role1.id).not.toBe(role2.id);
      expect(role1.name).toBe(role2.name);
    });
  });

  describe("findById", () => {
    test("should find a role by ID", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const created = await RoleModel.create({
        organizationId: org.id,
        name: "Find By ID Test",
        permissions: ["read"],
      });

      const found = await RoleModel.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("Find By ID Test");
    });

    test("should return null for non-existent role", async () => {
      const found = await RoleModel.findById("non-existent-id");
      expect(found).toBeNull();
    });
  });

  describe("findByName", () => {
    test("should find a role by name", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await RoleModel.create({
        organizationId: org.id,
        name: "Unique Role Name",
        permissions: ["read"],
      });

      const found = await RoleModel.findByName(org.id, "Unique Role Name");
      expect(found).toBeDefined();
      expect(found?.name).toBe("Unique Role Name");
    });

    test("should return null for non-existent role name", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const found = await RoleModel.findByName(org.id, "Non Existent");
      expect(found).toBeNull();
    });
  });

  describe("findByOrganization", () => {
    test("should list all roles for organization", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await RoleModel.create({
        organizationId: org.id,
        name: "Role 1",
        permissions: ["read"],
      });
      await RoleModel.create({
        organizationId: org.id,
        name: "Role 2",
        permissions: ["write"],
      });

      const roles = await RoleModel.findByOrganization(org.id);
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThanOrEqual(2);
    });

    test("should return empty array for org with no roles", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const roles = await RoleModel.findByOrganization(org.id);
      expect(Array.isArray(roles)).toBe(true);
    });
  });

  describe("update", () => {
    test("should update a role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "Original",
        permissions: ["read"],
      });

      const updated = await RoleModel.update(role.id, {
        name: "Updated",
        permissions: ["read", "write"],
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe("Updated");
      expect(updated?.permissions).toEqual(["read", "write"]);
    });

    test("should return null for non-existent role", async () => {
      const result = await RoleModel.update("non-existent-id", {
        name: "New Name",
      });
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    test("should delete a role", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const role = await RoleModel.create({
        organizationId: org.id,
        name: "To Delete",
        permissions: ["read"],
      });

      await RoleModel.delete(role.id);

      const found = await RoleModel.findById(role.id);
      expect(found).toBeNull();
    });

    test("should return false for non-existent role", async () => {
      const result = await RoleModel.delete("non-existent-id");
      expect(result).toBe(false);
    });
  });
});
