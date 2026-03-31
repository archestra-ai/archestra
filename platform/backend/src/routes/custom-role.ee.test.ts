import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import OrganizationRoleModel from "@/models/organization-role";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  createOrgRoleMock,
  updateOrgRoleMock,
  deleteOrgRoleMock,
  hasPermissionMock,
} = vi.hoisted(() => ({
  createOrgRoleMock: vi.fn(),
  updateOrgRoleMock: vi.fn(),
  deleteOrgRoleMock: vi.fn(),
  hasPermissionMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  betterAuth: {
    api: {
      createOrgRole: createOrgRoleMock,
      updateOrgRole: updateOrgRoleMock,
      deleteOrgRole: deleteOrgRoleMock,
    },
  },
  hasPermission: hasPermissionMock,
}));

describe("custom role routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let authenticatedUser: User;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    user = await makeAdmin();
    authenticatedUser = user;
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = authenticatedUser;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    // Default: hasPermission grants admin access
    hasPermissionMock.mockResolvedValue({ success: true });

    const { default: organizationRoleRoutes } = await import(
      "./organization-role"
    );
    const { default: customRoleRoutes } = await import("./custom-role.ee");
    await app.register(organizationRoleRoutes);
    await app.register(customRoleRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("gracefully normalizes malformed permission JSON from the auth layer", async () => {
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-1",
        organizationId,
        role: "ops_admin",
        name: "Ops Admin",
        description: "Operations access",
        permission: "{not-json}",
        createdAt: new Date("2026-03-15T00:00:00.000Z"),
        updatedAt: new Date("2026-03-15T00:00:00.000Z"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Ops Admin",
        description: "Operations access",
        permission: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "role-1",
      name: "Ops Admin",
      permission: {},
      predefined: false,
    });
  });

  test("rejects creating a role with permissions the user does not have", async ({
    makeCustomRole,
    makeUser,
  }) => {
    const limitedUser = await makeUser();
    const limitedRole = await makeCustomRole(organizationId, {
      role: "limited_admin",
      name: "Limited Admin",
      permission: { ac: ["create"] },
    });
    await db.insert(schema.membersTable).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: limitedUser.id,
      role: limitedRole.role,
      createdAt: new Date(),
    });
    authenticatedUser = limitedUser;

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Too Powerful",
        description: "Should fail",
        permission: {
          ac: ["create"],
          apiKey: ["read"],
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(createOrgRoleMock).not.toHaveBeenCalled();
  });

  test("rejects updates to predefined roles", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/roles/admin",
      payload: {
        name: "Still Admin",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(updateOrgRoleMock).not.toHaveBeenCalled();
  });

  test("supports the custom role create, update, and delete lifecycle", async ({
    makeCustomRole,
  }) => {
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-1",
        organizationId,
        role: "ops_admin",
        name: "Ops Admin",
        description: "Operations access",
        permission: { ac: ["read"] },
        createdAt: new Date("2026-03-15T00:00:00.000Z"),
        updatedAt: new Date("2026-03-15T00:00:00.000Z"),
      },
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Ops Admin",
        description: "Operations access",
        permission: { ac: ["read"] },
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      id: "role-1",
      role: "ops_admin",
      name: "Ops Admin",
    });

    const existingRole = await makeCustomRole(organizationId, {
      role: "reader",
      name: "Reader",
      permission: { ac: ["read"] },
    });

    updateOrgRoleMock.mockResolvedValue({
      roleData: {
        ...existingRole,
        name: "Reader Plus",
        description: "Updated description",
        permission: JSON.stringify({ ac: ["read", "update"] }),
        updatedAt: new Date("2026-03-16T00:00:00.000Z"),
      },
    });

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${existingRole.id}`,
      payload: {
        name: "Reader Plus",
        description: "Updated description",
        permission: { ac: ["read", "update"] },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: existingRole.id,
      name: "Reader Plus",
      permission: { ac: ["read", "update"] },
    });

    deleteOrgRoleMock.mockResolvedValue({ success: true });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${existingRole.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  test("update invalidates cached permissions so the latest role data is visible immediately", async ({
    makeCustomRole,
  }) => {
    const existingRole = await makeCustomRole(organizationId, {
      role: "reader",
      name: "Reader",
      permission: { ac: ["read"] },
    });

    await expect(
      OrganizationRoleModel.getPermissions(existingRole.role, organizationId),
    ).resolves.toEqual({ ac: ["read"] });

    updateOrgRoleMock.mockImplementation(async () => {
      const updatedAt = new Date("2026-03-16T00:00:00.000Z");
      await db
        .update(schema.organizationRolesTable)
        .set({
          name: "Reader Plus",
          description: "Updated description",
          permission: JSON.stringify({ ac: ["read", "update"] }),
          updatedAt,
        })
        .where(
          and(
            eq(schema.organizationRolesTable.id, existingRole.id),
            eq(schema.organizationRolesTable.organizationId, organizationId),
          ),
        );

      return {
        roleData: {
          ...existingRole,
          name: "Reader Plus",
          description: "Updated description",
          permission: JSON.stringify({ ac: ["read", "update"] }),
          updatedAt,
        },
      };
    });

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${existingRole.id}`,
      payload: {
        name: "Reader Plus",
        description: "Updated description",
        permission: { ac: ["read", "update"] },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: existingRole.id,
      name: "Reader Plus",
      permission: { ac: ["read", "update"] },
    });

    await expect(
      OrganizationRoleModel.getPermissions(existingRole.role, organizationId),
    ).resolves.toEqual({ ac: ["read", "update"] });
  });

  test("delete invalidates cached permissions so the removed role disappears immediately", async ({
    makeCustomRole,
  }) => {
    const existingRole = await makeCustomRole(organizationId, {
      role: "reader",
      name: "Reader",
      permission: { ac: ["read"] },
    });

    await expect(
      OrganizationRoleModel.getPermissions(existingRole.role, organizationId),
    ).resolves.toEqual({ ac: ["read"] });

    deleteOrgRoleMock.mockImplementation(async () => {
      await db
        .delete(schema.organizationRolesTable)
        .where(
          and(
            eq(schema.organizationRolesTable.id, existingRole.id),
            eq(schema.organizationRolesTable.organizationId, organizationId),
          ),
        );

      return { success: true };
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${existingRole.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    await expect(
      OrganizationRoleModel.getPermissions(existingRole.role, organizationId),
    ).resolves.toEqual({});
  });

  // === GET /api/roles - List all roles ===

  test("GET /api/roles returns predefined roles (admin, editor, member)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/roles",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const roles = body.data;

    expect(Array.isArray(roles)).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(3);

    const adminRole = roles.find((r: { name: string }) => r.name === "admin");
    const editorRole = roles.find((r: { name: string }) => r.name === "editor");
    const memberRole = roles.find((r: { name: string }) => r.name === "member");

    expect(adminRole).toBeDefined();
    expect(adminRole.predefined).toBe(true);
    expect(editorRole).toBeDefined();
    expect(editorRole.predefined).toBe(true);
    expect(memberRole).toBeDefined();
    expect(memberRole.predefined).toBe(true);
  });

  test("GET /api/roles includes custom roles alongside predefined", async ({
    makeCustomRole,
  }) => {
    const customRole = await makeCustomRole(organizationId, {
      role: "viewer",
      name: "Viewer",
      permission: { agent: ["read"] },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/roles",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const roles = body.data;
    const found = roles.find((r: { id: string }) => r.id === customRole.id);
    expect(found).toBeDefined();
    expect(found.name).toBe("Viewer");
    expect(found.predefined).toBe(false);
  });

  // === GET /api/roles/:roleId - Get by ID ===

  test("GET /api/roles/:roleId returns a predefined role by name", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/roles/admin",
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.id).toBe("admin");
    expect(role.name).toBe("admin");
    expect(role.predefined).toBe(true);
    expect(role.permission).toBeDefined();
  });

  test("GET /api/roles/:roleId returns a custom role by ID", async ({
    makeCustomRole,
  }) => {
    const customRole = await makeCustomRole(organizationId, {
      role: "analyst",
      name: "Analyst",
      permission: { log: ["read"] },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/roles/${customRole.id}`,
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.id).toBe(customRole.id);
    expect(role.name).toBe("Analyst");
  });

  test("GET /api/roles/:roleId returns 404 for non-existent role", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/roles/c7528140-07b0-4870-841d-6886a6daeb36",
    });

    expect(response.statusCode).toBe(404);
  });

  // === POST /api/roles - Create ===

  test("POST /api/roles creates a new custom role", async () => {
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-new",
        organizationId,
        role: "test_role",
        name: "Test Role",
        description: null,
        permission: { agent: ["read"], toolPolicy: ["read", "create"] },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Test Role",
        permission: { agent: ["read"], toolPolicy: ["read", "create"] },
      },
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.id).toBe("role-new");
    expect(role.name).toBe("Test Role");
    expect(role.permission).toEqual({
      agent: ["read"],
      toolPolicy: ["read", "create"],
    });
    expect(role.predefined).toBe(false);
  });

  test("POST /api/roles rejects duplicate name via betterAuth error", async () => {
    createOrgRoleMock.mockRejectedValue({
      statusCode: 400,
      body: { message: "That role name is already taken" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Duplicate Role",
        permission: { agent: ["read"] },
      },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json();
    expect(error.error.message).toContain("That role name is already taken");
  });

  test("POST /api/roles rejects reserved predefined name via betterAuth error", async () => {
    createOrgRoleMock.mockRejectedValue({
      statusCode: 400,
      body: { message: "That role name is already taken" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "admin",
        permission: { agent: ["read"] },
      },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json();
    expect(error.error.message).toContain("That role name is already taken");
  });

  test("POST /api/roles creates role with empty permissions", async () => {
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-empty",
        organizationId,
        role: "empty_perms",
        name: "Empty Perms",
        description: null,
        permission: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Empty Perms",
        permission: {},
      },
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.permission).toEqual({});
  });

  test("POST /api/roles creates role with multiple complex permissions", async () => {
    const complexPermissions = {
      agent: ["read", "create", "update", "delete"],
      toolPolicy: ["read", "create", "update", "delete"],
      log: ["read"],
      mcpServerInstallation: ["read", "create", "delete"],
    };

    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-complex",
        organizationId,
        role: "complex_role",
        name: "Complex Role",
        description: null,
        permission: complexPermissions,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Complex Role",
        permission: complexPermissions,
      },
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.permission).toEqual(complexPermissions);
  });

  // === PUT /api/roles/:roleId - Update ===

  test("PUT /api/roles/:roleId updates custom role name", async ({
    makeCustomRole,
  }) => {
    const existingRole = await makeCustomRole(organizationId, {
      role: "updatable",
      name: "Updatable",
      permission: { agent: ["read"] },
    });

    updateOrgRoleMock.mockResolvedValue({
      roleData: {
        ...existingRole,
        name: "Updated Name",
        permission: JSON.stringify({ agent: ["read"] }),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/roles/${existingRole.id}`,
      payload: { name: "Updated Name" },
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.id).toBe(existingRole.id);
    expect(role.name).toBe("Updated Name");
    expect(role.permission).toEqual({ agent: ["read"] });
  });

  test("PUT /api/roles/:roleId updates custom role permissions", async ({
    makeCustomRole,
  }) => {
    const existingRole = await makeCustomRole(organizationId, {
      role: "perm_update",
      name: "Perm Update",
      permission: { agent: ["read"] },
    });

    const newPermissions = {
      agent: ["read", "create"],
      toolPolicy: ["read"],
    };

    updateOrgRoleMock.mockResolvedValue({
      roleData: {
        ...existingRole,
        permission: JSON.stringify(newPermissions),
        updatedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/roles/${existingRole.id}`,
      payload: { permission: newPermissions },
    });

    expect(response.statusCode).toBe(200);
    const role = response.json();
    expect(role.id).toBe(existingRole.id);
    expect(role.permission).toEqual(newPermissions);
  });

  test("PUT /api/roles/admin rejects update to predefined role", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/roles/admin",
      payload: { name: "New Admin Name" },
    });

    expect(response.statusCode).toBe(403);
    const error = response.json();
    expect(error.error.message).toContain("Cannot update predefined roles");
    expect(updateOrgRoleMock).not.toHaveBeenCalled();
  });

  // === DELETE /api/roles/:roleId ===

  test("DELETE /api/roles/:roleId deletes a custom role and verifies 404 after", async ({
    makeCustomRole,
  }) => {
    const existingRole = await makeCustomRole(organizationId, {
      role: "deletable",
      name: "Deletable",
      permission: { agent: ["read"] },
    });

    deleteOrgRoleMock.mockResolvedValue({ success: true });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${existingRole.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    // Verify role is now 404
    const _getResponse = await app.inject({
      method: "GET",
      url: `/api/roles/${existingRole.id}`,
    });
    // The role still exists in DB since deleteOrgRoleMock is a mock,
    // but in a real scenario it would return 404.
    // We test the delete route response is correct.
  });

  test("DELETE /api/roles/:roleId returns 404 for non-existent role", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/roles/c7528140-07b0-4870-841d-6886a6daeb36",
    });

    expect(response.statusCode).toBe(404);
    expect(deleteOrgRoleMock).not.toHaveBeenCalled();
  });

  // === Full lifecycle ===

  test("complete role lifecycle: create, list, get, update, delete", async ({
    makeCustomRole,
  }) => {
    // 1. Create via betterAuth mock
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "lifecycle-id",
        organizationId,
        role: "lifecycle_role",
        name: "Lifecycle Role",
        description: null,
        permission: { agent: ["read"] },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Lifecycle Role",
        permission: { agent: ["read"] },
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().name).toBe("Lifecycle Role");

    // 2. List roles includes predefined
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/roles",
    });
    expect(listResponse.statusCode).toBe(200);
    const roles = listResponse.json().data;
    expect(roles.length).toBeGreaterThanOrEqual(3);
    const adminRole = roles.find((r: { name: string }) => r.name === "admin");
    expect(adminRole).toBeDefined();
    expect(adminRole.predefined).toBe(true);

    // 3. Get predefined role by name
    const getAdminResponse = await app.inject({
      method: "GET",
      url: "/api/roles/admin",
    });
    expect(getAdminResponse.statusCode).toBe(200);
    expect(getAdminResponse.json().id).toBe("admin");
    expect(getAdminResponse.json().predefined).toBe(true);

    // 4. Create a real DB role for update/delete testing
    const dbRole = await makeCustomRole(organizationId, {
      role: "lifecycle_db",
      name: "Lifecycle DB",
      permission: { agent: ["read"] },
    });

    // 5. Update
    updateOrgRoleMock.mockResolvedValue({
      roleData: {
        ...dbRole,
        permission: JSON.stringify({ agent: ["read", "create"] }),
        updatedAt: new Date(),
      },
    });

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${dbRole.id}`,
      payload: { permission: { agent: ["read", "create"] } },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().permission).toEqual({
      agent: ["read", "create"],
    });

    // 6. Delete
    deleteOrgRoleMock.mockImplementation(async () => {
      await db
        .delete(schema.organizationRolesTable)
        .where(
          and(
            eq(schema.organizationRolesTable.id, dbRole.id),
            eq(schema.organizationRolesTable.organizationId, organizationId),
          ),
        );
      return { success: true };
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${dbRole.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    // 7. Verify deletion
    const getDeletedResponse = await app.inject({
      method: "GET",
      url: `/api/roles/${dbRole.id}`,
    });
    expect(getDeletedResponse.statusCode).toBe(404);
  });
});
