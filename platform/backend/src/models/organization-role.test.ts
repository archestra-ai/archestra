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
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getById(customRole.id, org.id);

      expect(result).toMatchObject({
        id: customRole.id,
        role: "Custom Role",
        name: "Test Role",
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
        role: "custom_role",
        name: "Test Role",
        permission: { agent: ["read", "create"] },
      });

      const permissions = await OrganizationRoleModel.getPermissions(
        customRole.role,
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
        role: "Custom Role 1",
        name: "Test Role 1",
        permission: { agent: ["read"] },
      });

      await makeCustomRole(org.id, {
        role: "Custom Role 2",
        name: "Test Role 2",
        permission: { agent: ["create"] },
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
        permission: { agent: ["read"] },
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

  describe("getAllPaginated", () => {
    test("should return predefined roles first, then custom roles", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "custom_role",
        name: "Custom Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      // 3 predefined + 1 custom
      expect(result.data).toHaveLength(4);
      expect(result.pagination.total).toBe(4);

      // First 3 should be predefined (admin, editor, member)
      expect(result.data[0].predefined).toBe(true);
      expect(result.data[0].name).toBe(ADMIN_ROLE_NAME);
      expect(result.data[1].predefined).toBe(true);
      expect(result.data[1].name).toBe(EDITOR_ROLE_NAME);
      expect(result.data[2].predefined).toBe(true);
      expect(result.data[2].name).toBe(MEMBER_ROLE_NAME);

      // Last should be custom
      expect(result.data[3].predefined).toBe(false);
      expect(result.data[3].name).toBe("Custom Role");
    });

    test("should paginate across predefined and custom roles", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "custom_1",
        name: "Custom One",
        permission: { agent: ["read"] },
      });
      await makeCustomRole(org.id, {
        role: "custom_2",
        name: "Custom Two",
        permission: { agent: ["create"] },
      });

      // Page 1: should get first 3 (predefined roles)
      const page1 = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 3, offset: 0 },
        sorting: {},
      });

      expect(page1.data).toHaveLength(3);
      expect(page1.pagination.total).toBe(5);
      expect(page1.pagination.hasNext).toBe(true);
      expect(page1.pagination.hasPrev).toBe(false);
      expect(page1.data.every((r) => r.predefined)).toBe(true);

      // Page 2: should get 2 custom roles
      const page2 = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 3, offset: 3 },
        sorting: {},
      });

      expect(page2.data).toHaveLength(2);
      expect(page2.pagination.hasNext).toBe(false);
      expect(page2.pagination.hasPrev).toBe(true);
      expect(page2.data.every((r) => !r.predefined)).toBe(true);
    });

    test("should filter predefined roles by search", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "admin",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe(ADMIN_ROLE_NAME);
      expect(result.data[0].predefined).toBe(true);
    });

    test("should filter custom roles by search", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "viewer_role",
        name: "Viewer",
        permission: { agent: ["read"] },
      });
      await makeCustomRole(org.id, {
        role: "editor_custom",
        name: "Custom Editor",
        permission: { agent: ["read", "update"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "viewer",
      });

      // Should only match the custom "Viewer" role (not predefined ones)
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("Viewer");
    });

    test("should sort custom roles by name ascending", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "zebra_role",
        name: "Zebra Role",
        permission: { agent: ["read"] },
      });
      await makeCustomRole(org.id, {
        role: "alpha_role",
        name: "Alpha Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "asc" },
      });

      // Predefined first, then custom sorted by name asc
      const customRoles = result.data.filter((r) => !r.predefined);
      expect(customRoles).toHaveLength(2);
      expect(customRoles[0].name).toBe("Alpha Role");
      expect(customRoles[1].name).toBe("Zebra Role");
    });

    test("should sort custom roles by name descending", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "zebra_role",
        name: "Zebra Role",
        permission: { agent: ["read"] },
      });
      await makeCustomRole(org.id, {
        role: "alpha_role",
        name: "Alpha Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "desc" },
      });

      const customRoles = result.data.filter((r) => !r.predefined);
      expect(customRoles).toHaveLength(2);
      expect(customRoles[0].name).toBe("Zebra Role");
      expect(customRoles[1].name).toBe("Alpha Role");
    });

    test("should return only predefined roles when no custom roles exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      expect(result.data).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
      expect(result.data.every((r) => r.predefined)).toBe(true);
    });

    test("should return empty when search matches nothing", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "nonexistent",
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });

    test("should not return custom roles from other organizations", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      await makeCustomRole(org1.id, {
        role: "org1_role",
        name: "Org1 Custom Role",
        permission: { agent: ["read"] },
      });
      await makeCustomRole(org2.id, {
        role: "org2_role",
        name: "Org2 Custom Role",
        permission: { agent: ["read"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org1.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
      });

      // 3 predefined + 1 custom from org1
      expect(result.data).toHaveLength(4);
      const customRoles = result.data.filter((r) => !r.predefined);
      expect(customRoles).toHaveLength(1);
      expect(customRoles[0].name).toBe("Org1 Custom Role");
    });

    test("should search across both predefined and custom roles simultaneously", async ({
      makeOrganization,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      await makeCustomRole(org.id, {
        role: "member_extended",
        name: "Member Extended",
        permission: { agent: ["read", "create"] },
      });

      const result = await OrganizationRoleModel.getAllPaginated({
        organizationId: org.id,
        pagination: { limit: 20, offset: 0 },
        sorting: {},
        search: "member",
      });

      // Should match predefined "member" and custom "Member Extended"
      expect(result.data).toHaveLength(2);
      const names = result.data.map((r) => r.name);
      expect(names).toContain(MEMBER_ROLE_NAME);
      expect(names).toContain("Member Extended");
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
        role: "custom_role_with_members",
        name: "Test Role With Members",
        permission: { agent: ["read"] },
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
