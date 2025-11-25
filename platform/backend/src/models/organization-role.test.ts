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
        role: "Custom Role",
        name: "Test Role",
        permission: { profile: ["read"] },
      });

      const result = await OrganizationRoleModel.getById(customRole.id, org.id);

      expect(result).toMatchObject({
        id: customRole.id,
        role: "Custom Role",
        name: "Test Role",
        organizationId: org.id,
        permission: { profile: ["read"] },
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
        role: "Custom Role",
        name: "Test Role",
        permission: { profile: ["read", "create"] },
      });

      const permissions = await OrganizationRoleModel.getPermissions(
        customRole.id,
        org.id,
      );
      expect(permissions).toEqual({
        profile: ["read", "create"],
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
        role: "Custom Role 1",
        name: "Test Role 1",
        permission: { profile: ["read"] },
      });

      await makeCustomRole(org.id, {
        role: "Custom Role 2",
        name: "Test Role 2",
        permission: { profile: ["create"] },
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
        role: "Custom Role 1",
        name: "Test Role 1",
        permission: { profile: ["read"] },
      });
    });

    test("should return only predefined roles when no custom roles exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getAll(org.id);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe(ADMIN_ROLE_NAME);
      expect(result[1].role).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("create", () => {
    test("should create custom role successfully", async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const newRole = await makeCustomRole(org.id, {
        role: "New Role",
        name: "Test Role",
        permission: { profile: ["read"], organization: ["read"] },
      });

      expect(newRole).toMatchObject({
        id: newRole.id,
        role: "New Role",
        name: "Test Role",
        permission: { profile: ["read"], organization: ["read"] },
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
        role: "initial_role",
        name: "Initial Name",
        permission: { profile: ["read"] },
      });

      // Update the role
      const updateData: UpdateOrganizationRole = {
        name: "Updated Name",
        permission: { profile: ["create", "update"] },
      };

      const result = await OrganizationRoleModel.update(
        {} as HeadersInit,
        initialRole.id,
        org.id,
        updateData,
      );

      expect(result).toMatchObject({
        id: initialRole.id,
        role: "initial_role", // role is immutable
        name: "Updated Name", // name can be updated
        organizationId: org.id,
        permission: { profile: ["create", "update"] },
        predefined: false,
      });

      // Verify update persisted
      const retrieved = await OrganizationRoleModel.getById(
        initialRole.id,
        org.id,
      );
      expect(retrieved?.role).toBe("initial_role"); // role is immutable
      expect(retrieved?.name).toBe("Updated Title"); // title can be updated
      expect(retrieved?.permission).toEqual({
        profile: ["create", "update"],
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
        role: "Role to Delete",
        name: "Test Role to Delete",
        permission: { profile: ["read"] },
      });

      // Verify it exists
      const beforeDelete = await OrganizationRoleModel.getById(
        roleToDelete.id,
        org.id,
      );
      expect(beforeDelete).not.toBeNull();

      // Delete it
      const result = await OrganizationRoleModel.delete(
        {} as HeadersInit,
        roleToDelete.id,
        org.id,
      );
      expect(result).toBe(true);

      // Verify it's gone
      const afterDelete = await OrganizationRoleModel.getById(
        roleToDelete.id,
        org.id,
      );
      expect(afterDelete).toBeFalsy();
    });

    test("should return true even when no role was deleted", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.delete(
        {} as HeadersInit,
        crypto.randomUUID(),
        org.id,
      );
      expect(result).toBe(true);
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
        role: "Custom Role",
        name: "Test Role",
        permission: { profile: ["read"] },
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
        role: "Custom Role With Members",
        name: "Test Role With Members",
        permission: { profile: ["read"] },
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
