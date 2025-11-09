import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  predefinedPermissionsMap,
} from "@shared";
import { describe, expect, test } from "@/test";
import type { UpdateOrganizationRole } from "@/types";
import OrganizationRoleModel from "./organization-role";

describe("OrganizationRoleModel", () => {
  describe("isPredefinedRole", () => {
    test("should return true for admin role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(ADMIN_ROLE_NAME)).toBe(
        true,
      );
    });

    test("should return true for member role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(MEMBER_ROLE_NAME)).toBe(
        true,
      );
    });

    test("should return false for custom role names", () => {
      expect(OrganizationRoleModel.isPredefinedRole("custom-role")).toBe(false);
      expect(OrganizationRoleModel.isPredefinedRole("uuid-123")).toBe(false);
    });

    test("should return false for empty string", () => {
      expect(OrganizationRoleModel.isPredefinedRole("")).toBe(false);
    });
  });

  describe("getPredefinedRolePermissions", () => {
    test("should return admin permissions", () => {
      const permissions =
        OrganizationRoleModel.getPredefinedRolePermissions(ADMIN_ROLE_NAME);
      expect(permissions).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
    });

    test("should return member permissions", () => {
      const permissions =
        OrganizationRoleModel.getPredefinedRolePermissions(MEMBER_ROLE_NAME);
      expect(permissions).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
    });
  });

  describe("getById", () => {
    test("should return predefined admin role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getById(
        ADMIN_ROLE_NAME,
        org.id,
      );

      expect(result).toMatchObject({
        id: ADMIN_ROLE_NAME,
        name: ADMIN_ROLE_NAME,
        organizationId: org.id,
        permission: predefinedPermissionsMap[ADMIN_ROLE_NAME],
        predefined: true,
      });
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });

    test("should return predefined member role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getById(
        MEMBER_ROLE_NAME,
        org.id,
      );

      expect(result).toMatchObject({
        id: MEMBER_ROLE_NAME,
        name: MEMBER_ROLE_NAME,
        organizationId: org.id,
        permission: predefinedPermissionsMap[MEMBER_ROLE_NAME],
        predefined: true,
      });
    });

    test("should return custom role from database", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const customRole = await makeCustomRole(org.id, {
        name: "Custom Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getById(customRole.id, org.id);

      expect(result).toMatchObject({
        id: customRole.id,
        name: "Custom Role",
        organizationId: org.id,
        permission: { agent: ["read"] },
        predefined: false,
      });
    });

    test("should return null for non-existent custom role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getById(
        crypto.randomUUID(),
        org.id,
      );
      expect(result).toBeFalsy();
    });
  });

  describe("getPermissions", () => {
    test("should return predefined role permissions", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const permissions = await OrganizationRoleModel.getPermissions(
        ADMIN_ROLE_NAME,
        org.id,
      );
      expect(permissions).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
    });

    test("should return custom role permissions", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const customRole = await makeCustomRole(org.id, {
        name: "Custom Role",
        permission: { agent: ["read", "create"] },
      });

      const permissions = await OrganizationRoleModel.getPermissions(
        customRole.id,
        org.id,
      );
      expect(permissions).toEqual({
        agent: ["read", "create"],
      });
    });

    test("should return empty permissions for non-existent role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const permissions = await OrganizationRoleModel.getPermissions(
        crypto.randomUUID(),
        org.id,
      );
      expect(permissions).toEqual({});
    });
  });

  describe("getAll", () => {
    test("should return predefined roles plus custom roles", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      // Create some custom roles
      const customRole1 = await makeCustomRole(org.id, {
        name: "Custom Role 1",
        permission: { agent: ["read"] },
      });

      await makeCustomRole(org.id, {
        name: "Custom Role 2",
        permission: { agent: ["create"] },
      });

      const result = await OrganizationRoleModel.getAll(org.id);

      expect(result).toHaveLength(4); // 2 predefined + 2 custom

      // Check predefined roles
      expect(result[0]).toMatchObject({
        id: ADMIN_ROLE_NAME,
        name: ADMIN_ROLE_NAME,
        predefined: true,
      });
      expect(result[1]).toMatchObject({
        id: MEMBER_ROLE_NAME,
        name: MEMBER_ROLE_NAME,
        predefined: true,
      });

      // Check custom roles (should be sorted by name)
      const customRoles = result.filter((r) => !r.predefined);
      expect(customRoles).toHaveLength(2);
      expect(customRoles.find((r) => r.id === customRole1.id)).toMatchObject({
        id: customRole1.id,
        name: "Custom Role 1",
        permission: { agent: ["read"] },
      });
    });

    test("should return only predefined roles when no custom roles exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getAll(org.id);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe(ADMIN_ROLE_NAME);
      expect(result[1].name).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("isNameUnique", () => {
    test("should return false for predefined role names", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const isUnique = await OrganizationRoleModel.isNameUnique(
        ADMIN_ROLE_NAME,
        org.id,
      );
      expect(isUnique).toBe(false);
    });

    test("should return true for unique custom role name", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const isUnique = await OrganizationRoleModel.isNameUnique(
        "unique-name",
        org.id,
      );
      expect(isUnique).toBe(true);
    });

    test("should return false for existing custom role name", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        name: "Existing Role",
        permission: { agent: ["read"] },
      });

      const isUnique = await OrganizationRoleModel.isNameUnique(
        "Existing Role",
        org.id,
      );
      expect(isUnique).toBe(false);
    });

    test("should exclude current role when checking uniqueness", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      // Create a custom role
      const currentRole = await makeCustomRole(org.id, {
        name: "Current Role",
        permission: { agent: ["read"] },
      });

      // Should return true when excluding the current role
      const isUnique = await OrganizationRoleModel.isNameUnique(
        "Current Role",
        org.id,
        currentRole.id,
      );
      expect(isUnique).toBe(true);
    });
  });

  describe("create", () => {
    test("should create custom role successfully", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const newRole = await makeCustomRole(org.id, {
        name: "New Role",
        permission: { agent: ["read"], organization: ["read"] },
      });

      expect(newRole).toMatchObject({
        id: newRole.id,
        name: "New Role",
        permission: { agent: ["read"], organization: ["read"] },
        predefined: false,
      });
    });
  });

  describe("update", () => {
    test("should update custom role successfully", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      // Create initial role
      const initialRole = await makeCustomRole(org.id, {
        name: "Initial Name",
        permission: { agent: ["read"] },
      });

      // Update the role
      const updateData: UpdateOrganizationRole = {
        name: "Updated Name",
        permission: { agent: ["create", "update"] },
      };

      const result = await OrganizationRoleModel.update(
        initialRole.id,
        updateData,
      );

      expect(result).toMatchObject({
        id: initialRole.id,
        name: "Updated Name",
        organizationId: org.id,
        permission: { agent: ["create", "update"] },
        predefined: false,
      });

      // Verify update persisted
      const retrieved = await OrganizationRoleModel.getById(
        initialRole.id,
        org.id,
      );
      expect(retrieved?.name).toBe("Updated Name");
      expect(retrieved?.permission).toEqual({
        agent: ["create", "update"],
      });
    });
  });

  describe("delete", () => {
    test("should delete role successfully", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      // Create role to delete
      const roleToDelete = await makeCustomRole(org.id, {
        name: "Role to Delete",
        permission: { agent: ["read"] },
      });

      // Verify it exists
      const beforeDelete = await OrganizationRoleModel.getById(
        roleToDelete.id,
        org.id,
      );
      expect(beforeDelete).not.toBeNull();

      // Delete it
      const result = await OrganizationRoleModel.delete(roleToDelete.id);
      expect(result).toBe(true);

      // Verify it's gone
      const afterDelete = await OrganizationRoleModel.getById(
        roleToDelete.id,
        org.id,
      );
      expect(afterDelete).toBeFalsy();
    });

    test("should return false when no role was deleted", async () => {
      const result = await OrganizationRoleModel.delete(crypto.randomUUID());
      expect(result).toBe(false);
    });
  });

  describe("canDelete", () => {
    test("should return false for predefined roles", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.canDelete(
        ADMIN_ROLE_NAME,
        org.id,
      );

      expect(result).toEqual({
        canDelete: false,
        reason: "Cannot delete predefined roles",
      });
    });

    test("should return false for non-existent role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.canDelete(
        crypto.randomUUID(),
        org.id,
      );

      expect(result).toEqual({
        canDelete: false,
        reason: "Role not found",
      });
    });

    test("should return true for custom role with no members", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      // Create custom role
      const customRole = await makeCustomRole(org.id, {
        name: "Custom Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.canDelete(
        customRole.id,
        org.id,
      );
      expect(result).toEqual({ canDelete: true });
    });

    test("should return false for custom role with members", async ({
      makeCustomRole,
      makeUser,
      makeMember,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      // Create custom role
      const customRole = await makeCustomRole(org.id, {
        name: "Custom Role With Members",
        permission: { agent: ["read"] },
      });

      // Create a user and assign them to this role
      await makeMember(user.id, org.id, { role: customRole.id });

      const result = await OrganizationRoleModel.canDelete(
        customRole.id,
        org.id,
      );
      expect(result).toEqual({
        canDelete: false,
        reason: "Cannot delete role that is currently assigned to members",
      });
    });
  });
});
