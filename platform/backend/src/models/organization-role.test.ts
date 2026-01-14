import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { predefinedPermissionsMap } from "@shared/access-control";
import { describe, expect, test } from "@/test";
import OrganizationRoleModel from "./organization-role";

describe("OrganizationRoleModel", () => {
  describe("isPredefinedRole", () => {
    test("should return true for admin role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(ADMIN_ROLE_NAME)).toBe(
        true,
      );
    });

    test("should return true for editor role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(EDITOR_ROLE_NAME)).toBe(
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

    test("should return editor permissions", () => {
      const permissions =
        OrganizationRoleModel.getPredefinedRolePermissions(EDITOR_ROLE_NAME);
      expect(permissions).toEqual(predefinedPermissionsMap[EDITOR_ROLE_NAME]);
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

    test("should return predefined editor role", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const result = await OrganizationRoleModel.getById(
        EDITOR_ROLE_NAME,
        org.id,
      );

      expect(result).toMatchObject({
        id: EDITOR_ROLE_NAME,
        name: EDITOR_ROLE_NAME,
        organizationId: org.id,
        permission: predefinedPermissionsMap[EDITOR_ROLE_NAME],
        predefined: true,
      });
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
        role: "custom_role",
        name: "Test Role",
        permission: { profile: ["read", "create"] },
      });

      const permissions = await OrganizationRoleModel.getPermissions(
        customRole.role,
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

      expect(result).toHaveLength(5); // 3 predefined + 2 custom

      // Check predefined roles
      expect(result[0]).toMatchObject({
        id: ADMIN_ROLE_NAME,
        name: ADMIN_ROLE_NAME,
        predefined: true,
      });
      expect(result[1]).toMatchObject({
        id: EDITOR_ROLE_NAME,
        name: EDITOR_ROLE_NAME,
        predefined: true,
      });
      expect(result[2]).toMatchObject({
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

      expect(result).toHaveLength(3);
      expect(result[0].role).toBe(ADMIN_ROLE_NAME);
      expect(result[1].role).toBe(EDITOR_ROLE_NAME);
      expect(result[2].role).toBe(MEMBER_ROLE_NAME);
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
        role: "custom_role_with_members",
        name: "Test Role With Members",
        permission: { profile: ["read"] },
      });

      // Create a user and assign them to this role (using role identifier, not ID)
      await makeMember(user.id, org.id, { role: customRole.role });

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
