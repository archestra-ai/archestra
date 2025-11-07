import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  predefinedPermissionsMap,
} from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertOrganizationRole, UpdateOrganizationRole } from "@/types";
import OrganizationRoleModel from "./organization-role";

describe("OrganizationRoleModel", () => {
  let testOrgId: string;

  beforeEach(async () => {
    testOrgId = crypto.randomUUID();
    // Create test organization
    await db.insert(schema.organizationsTable).values({
      id: testOrgId,
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up custom roles after each test
    await db
      .delete(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.organizationId, testOrgId));
  });

  describe("isPredefinedRole", () => {
    it("should return true for admin role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(ADMIN_ROLE_NAME)).toBe(
        true,
      );
    });

    it("should return true for member role", () => {
      expect(OrganizationRoleModel.isPredefinedRole(MEMBER_ROLE_NAME)).toBe(
        true,
      );
    });

    it("should return false for custom role names", () => {
      expect(OrganizationRoleModel.isPredefinedRole("custom-role")).toBe(false);
      expect(OrganizationRoleModel.isPredefinedRole("uuid-123")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(OrganizationRoleModel.isPredefinedRole("")).toBe(false);
    });
  });

  describe("getPredefinedRolePermissions", () => {
    it("should return admin permissions", () => {
      const permissions =
        OrganizationRoleModel.getPredefinedRolePermissions(ADMIN_ROLE_NAME);
      expect(permissions).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
    });

    it("should return member permissions", () => {
      const permissions =
        OrganizationRoleModel.getPredefinedRolePermissions(MEMBER_ROLE_NAME);
      expect(permissions).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
    });
  });

  describe("getById", () => {
    it("should return predefined admin role", async () => {
      const result = await OrganizationRoleModel.getById(
        ADMIN_ROLE_NAME,
        testOrgId,
      );

      expect(result).toMatchObject({
        id: ADMIN_ROLE_NAME,
        name: ADMIN_ROLE_NAME,
        organizationId: testOrgId,
        permission: predefinedPermissionsMap[ADMIN_ROLE_NAME],
        predefined: true,
      });
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });

    it("should return predefined member role", async () => {
      const result = await OrganizationRoleModel.getById(
        MEMBER_ROLE_NAME,
        testOrgId,
      );

      expect(result).toMatchObject({
        id: MEMBER_ROLE_NAME,
        name: MEMBER_ROLE_NAME,
        organizationId: testOrgId,
        permission: predefinedPermissionsMap[MEMBER_ROLE_NAME],
        predefined: true,
      });
    });

    it("should return custom role from database", async () => {
      // Create a custom role
      const customRoleId = crypto.randomUUID();
      const customRole: InsertOrganizationRole = {
        id: customRoleId,
        name: "Custom Role",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };

      await OrganizationRoleModel.create(customRole);

      const result = await OrganizationRoleModel.getById(
        customRoleId,
        testOrgId,
      );

      expect(result).toMatchObject({
        id: customRoleId,
        name: "Custom Role",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
        predefined: false,
      });
    });

    it("should return null for non-existent custom role", async () => {
      const result = await OrganizationRoleModel.getById(
        crypto.randomUUID(),
        testOrgId,
      );
      expect(result).toBeFalsy();
    });
  });

  describe("getPermissions", () => {
    it("should return predefined role permissions", async () => {
      const permissions = await OrganizationRoleModel.getPermissions(
        ADMIN_ROLE_NAME,
        testOrgId,
      );
      expect(permissions).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
    });

    it("should return custom role permissions", async () => {
      const customRoleId = crypto.randomUUID();
      const customRole: InsertOrganizationRole = {
        id: customRoleId,
        name: "Custom Role",
        organizationId: testOrgId,
        permission: { agent: ["read", "create"] },
      };

      await OrganizationRoleModel.create(customRole);

      const permissions = await OrganizationRoleModel.getPermissions(
        customRoleId,
        testOrgId,
      );
      expect(permissions).toEqual({
        agent: ["read", "create"],
      });
    });

    it("should return empty permissions for non-existent role", async () => {
      const permissions = await OrganizationRoleModel.getPermissions(
        crypto.randomUUID(),
        testOrgId,
      );
      expect(permissions).toEqual({});
    });
  });

  describe("getAll", () => {
    it("should return predefined roles plus custom roles", async () => {
      // Create some custom roles
      const customRole1Id = crypto.randomUUID();
      const customRole1: InsertOrganizationRole = {
        id: customRole1Id,
        name: "Custom Role 1",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };

      const customRole2Id = crypto.randomUUID();
      const customRole2: InsertOrganizationRole = {
        id: customRole2Id,
        name: "Custom Role 2",
        organizationId: testOrgId,
        permission: { agent: ["create"] },
      };

      await OrganizationRoleModel.create(customRole1);
      await OrganizationRoleModel.create(customRole2);

      const result = await OrganizationRoleModel.getAll(testOrgId);

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
      expect(customRoles.find((r) => r.id === customRole1Id)).toMatchObject({
        id: customRole1Id,
        name: "Custom Role 1",
        permission: { agent: ["read"] },
      });
    });

    it("should return only predefined roles when no custom roles exist", async () => {
      const result = await OrganizationRoleModel.getAll(testOrgId);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe(ADMIN_ROLE_NAME);
      expect(result[1].name).toBe(MEMBER_ROLE_NAME);
    });
  });

  describe("isNameUnique", () => {
    it("should return false for predefined role names", async () => {
      const isUnique = await OrganizationRoleModel.isNameUnique(
        ADMIN_ROLE_NAME,
        testOrgId,
      );
      expect(isUnique).toBe(false);
    });

    it("should return true for unique custom role name", async () => {
      const isUnique = await OrganizationRoleModel.isNameUnique(
        "unique-name",
        testOrgId,
      );
      expect(isUnique).toBe(true);
    });

    it("should return false for existing custom role name", async () => {
      // Create a custom role
      const customRole: InsertOrganizationRole = {
        id: crypto.randomUUID(),
        name: "Existing Role",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(customRole);

      const isUnique = await OrganizationRoleModel.isNameUnique(
        "Existing Role",
        testOrgId,
      );
      expect(isUnique).toBe(false);
    });

    it("should exclude current role when checking uniqueness", async () => {
      // Create a custom role
      const currentRoleId = crypto.randomUUID();
      const customRole: InsertOrganizationRole = {
        id: currentRoleId,
        name: "Current Role",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(customRole);

      // Should return true when excluding the current role
      const isUnique = await OrganizationRoleModel.isNameUnique(
        "Current Role",
        testOrgId,
        currentRoleId,
      );
      expect(isUnique).toBe(true);
    });
  });

  describe("create", () => {
    it("should create custom role successfully", async () => {
      const newRoleId = crypto.randomUUID();
      const newRole: InsertOrganizationRole = {
        id: newRoleId,
        name: "New Role",
        organizationId: testOrgId,
        permission: { agent: ["read"], organization: ["read"] },
      };

      const result = await OrganizationRoleModel.create(newRole);

      expect(result).toMatchObject({
        id: newRoleId,
        name: "New Role",
        organizationId: testOrgId,
        permission: { agent: ["read"], organization: ["read"] },
        predefined: false,
      });
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);

      // Verify it exists in database
      const retrieved = await OrganizationRoleModel.getById(
        newRoleId,
        testOrgId,
      );
      expect(retrieved).toMatchObject(newRole);
    });
  });

  describe("update", () => {
    it("should update custom role successfully", async () => {
      // Create initial role
      const initialRoleId = crypto.randomUUID();
      const initialRole: InsertOrganizationRole = {
        id: initialRoleId,
        name: "Initial Name",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(initialRole);

      // Update the role
      const updateData: UpdateOrganizationRole = {
        name: "Updated Name",
        permission: { agent: ["create", "update"] },
      };

      const result = await OrganizationRoleModel.update(
        initialRoleId,
        updateData,
      );

      expect(result).toMatchObject({
        id: initialRoleId,
        name: "Updated Name",
        organizationId: testOrgId,
        permission: { agent: ["create", "update"] },
        predefined: false,
      });

      // Verify update persisted
      const retrieved = await OrganizationRoleModel.getById(
        initialRoleId,
        testOrgId,
      );
      expect(retrieved?.name).toBe("Updated Name");
      expect(retrieved?.permission).toEqual({
        agent: ["create", "update"],
      });
    });
  });

  describe("delete", () => {
    it("should delete role successfully", async () => {
      // Create role to delete
      const roleToDeleteId = crypto.randomUUID();
      const roleToDelete: InsertOrganizationRole = {
        id: roleToDeleteId,
        name: "Role to Delete",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(roleToDelete);

      // Verify it exists
      const beforeDelete = await OrganizationRoleModel.getById(
        roleToDeleteId,
        testOrgId,
      );
      expect(beforeDelete).not.toBeNull();

      // Delete it
      const result = await OrganizationRoleModel.delete(roleToDeleteId);
      expect(result).toBe(true);

      // Verify it's gone
      const afterDelete = await OrganizationRoleModel.getById(
        roleToDeleteId,
        testOrgId,
      );
      expect(afterDelete).toBeFalsy();
    });

    it("should return false when no role was deleted", async () => {
      const result = await OrganizationRoleModel.delete(crypto.randomUUID());
      expect(result).toBe(false);
    });
  });

  describe("canDelete", () => {
    it("should return false for predefined roles", async () => {
      const result = await OrganizationRoleModel.canDelete(
        ADMIN_ROLE_NAME,
        testOrgId,
      );

      expect(result).toEqual({
        canDelete: false,
        reason: "Cannot delete predefined roles",
      });
    });

    it("should return false for non-existent role", async () => {
      const result = await OrganizationRoleModel.canDelete(
        crypto.randomUUID(),
        testOrgId,
      );

      expect(result).toEqual({
        canDelete: false,
        reason: "Role not found",
      });
    });

    it("should return true for custom role with no members", async () => {
      // Create custom role
      const customRoleId = crypto.randomUUID();
      const customRole: InsertOrganizationRole = {
        id: customRoleId,
        name: "Custom Role",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(customRole);

      const result = await OrganizationRoleModel.canDelete(
        customRoleId,
        testOrgId,
      );
      expect(result).toEqual({ canDelete: true });
    });

    it("should return false for custom role with members", async () => {
      // Create custom role
      const customRoleId = crypto.randomUUID();
      const customRole: InsertOrganizationRole = {
        id: customRoleId,
        name: "Custom Role With Members",
        organizationId: testOrgId,
        permission: { agent: ["read"] },
      };
      await OrganizationRoleModel.create(customRole);

      // Create a user and assign them to this role
      const userId = crypto.randomUUID();
      await db.insert(schema.usersTable).values({
        id: userId,
        email: "test@example.com",
        name: "Test User",
      });

      await db.insert(schema.member).values({
        userId,
        organizationId: testOrgId,
        role: customRoleId,
        createdAt: new Date(),
        id: crypto.randomUUID(),
      });

      const result = await OrganizationRoleModel.canDelete(
        customRoleId,
        testOrgId,
      );
      expect(result).toEqual({
        canDelete: false,
        reason: "Cannot delete role that is currently assigned to members",
      });

      // Cleanup
      await db.delete(schema.member).where(eq(schema.member.userId, userId));
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, userId));
    });
  });
});
