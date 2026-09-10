import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission } from "@/auth";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import OrganizationRoleModel from "@/models/organization-role";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const hasPermissionMock = vi.mocked(hasPermission);

describe("custom role routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let authenticatedUser: User;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();

    // Small team => enterprise core active. The shared setup's reset targets
    // the clean project's module registry; this mocked-project file has to
    // seed the instance its own route imports.
    enterpriseTier.setUserCountForTesting(0);

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
    hasPermissionMock.mockResolvedValue({ success: true, error: null });

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

  /**
   * Regression: role creation used to be delegated to better-auth's
   * `createOrgRole`, which re-checked every `resource:action` pair against
   * the author's role with rules of its own — no exemption for the UI-only
   * resources, and no tolerance for the vestigial actions the predefined sets
   * still carry. Duplicating a role carried those pairs along in the payload
   * and the write was refused ("You are not allowed to create a role") even
   * though `/api/roles` had already cleared it. Authorization now lives in
   * one place: `findUngrantablePermissions`.
   */
  test("accepts a vestigial action the predefined editor role still lists", async () => {
    // `invitation: ["read"]` is not in the permission universe — it grants
    // nothing, and it rides along whenever the Editor role is duplicated.
    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Editor Copy",
        permission: { invitation: ["read"], agent: ["read"] },
      },
    });

    expect(response.statusCode).toBe(200);
    // Stored sanitized: the pair grants nothing, so it does not survive.
    expect(response.json().permission).toEqual({ agent: ["read"] });
  });

  test("accepts a UI-only permission the author's own role does not hold", async ({
    makeCustomRole,
    makeUser,
  }) => {
    // `simpleView:enable` is a display preference, not a privilege: admin
    // deliberately holds less of it than member, so granting it is exempt
    // from the no-escalation rule. An author without it must still be able to
    // hand it to a role.
    const author = await makeUser();
    const authorRole = await makeCustomRole(organizationId, {
      role: "role_maker",
      name: "Role Maker",
      permission: { ac: ["create"], agent: ["read"] },
    });
    await db.insert(schema.membersTable).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: author.id,
      role: authorRole.role,
      createdAt: new Date(),
    });
    authenticatedUser = author;

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Collapsed Sidebar",
        permission: { agent: ["read"], simpleView: ["enable"] },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().permission).toEqual({
      agent: ["read"],
      simpleView: ["enable"],
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
    expect(
      await OrganizationRoleModel.getByIdentifier(
        "too_powerful",
        organizationId,
      ),
    ).toBeNull();
  });

  test("rejects updating a role to grant permissions the user does not have", async ({
    makeUser,
    makeCustomRole,
  }) => {
    const limitedUser = await makeUser();
    const limitedRole = await makeCustomRole(organizationId, {
      permission: { ac: ["read", "update"] },
    });
    await db.insert(schema.membersTable).values({
      id: crypto.randomUUID(),
      userId: limitedUser.id,
      organizationId,
      role: limitedRole.role,
      createdAt: new Date(),
    });
    const targetRole = await makeCustomRole(organizationId, {
      permission: { ac: ["read"] },
    });

    authenticatedUser = limitedUser;
    const response = await app.inject({
      method: "PUT",
      url: `/api/roles/${targetRole.id}`,
      payload: { permission: { ac: ["read"], auditLog: ["read"] } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("auditLog:read");
    expect(
      (await OrganizationRoleModel.getById(targetRole.id, organizationId))
        ?.permission,
    ).toEqual({ ac: ["read"] });
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
  });

  test("supports the custom role create, update, and delete lifecycle", async () => {
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
      role: "ops_admin",
      name: "Ops Admin",
      description: "Operations access",
      permission: { ac: ["read"] },
      predefined: false,
    });
    const roleId = createResponse.json().id;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${roleId}`,
      payload: {
        name: "Ops Admin Plus",
        description: "Updated description",
        permission: { ac: ["read", "update"] },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: roleId,
      // The identifier is immutable; only the display name changes.
      role: "ops_admin",
      name: "Ops Admin Plus",
      permission: { ac: ["read", "update"] },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${roleId}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
    expect(
      await OrganizationRoleModel.getById(roleId, organizationId),
    ).toBeNull();
  });

  test("permission edits resync holders' system-level user.role", async ({
    makeCustomRole,
    makeUser,
    makeMember,
  }) => {
    const role = await makeCustomRole(organizationId, {
      role: "sec_auditor",
      name: "Security Auditor",
      permission: { member: ["read"] },
    });
    const holder = await makeUser();
    await makeMember(holder.id, organizationId, { role: role.role });

    const grantResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${role.id}`,
      payload: { permission: { member: ["read", "impersonate"] } },
    });
    expect(grantResponse.statusCode).toBe(200);

    const [afterGrant] = await db
      .select({ role: schema.usersTable.role })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, holder.id));
    expect(afterGrant.role).toBe("admin");

    const revokeResponse = await app.inject({
      method: "PUT",
      url: `/api/roles/${role.id}`,
      payload: { permission: { member: ["read"] } },
    });
    expect(revokeResponse.statusCode).toBe(200);

    const [afterRevoke] = await db
      .select({ role: schema.usersTable.role })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, holder.id));
    expect(afterRevoke.role).toBeNull();
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

    const adminRole = roles.find((r: { role: string }) => r.role === "admin");
    const editorRole = roles.find((r: { role: string }) => r.role === "editor");
    const memberRole = roles.find((r: { role: string }) => r.role === "member");

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
    expect(role.name).toBe("Admin");
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

  test("GET /api/roles/:roleId strips stale invalid permissions from custom roles", async ({
    makeCustomRole,
  }) => {
    const customRole = await makeCustomRole(organizationId, {
      role: "legacy_analyst",
      name: "Legacy Analyst",
      permission: { log: ["read"] },
    });

    await db
      .update(schema.organizationRolesTable)
      .set({
        permission: JSON.stringify({
          log: ["read", "create", "update", "delete"],
          llmLimit: ["team-admin"],
          unknownResource: ["read"],
        }),
      })
      .where(
        and(
          eq(schema.organizationRolesTable.id, customRole.id),
          eq(schema.organizationRolesTable.organizationId, organizationId),
        ),
      );

    const response = await app.inject({
      method: "GET",
      url: `/api/roles/${customRole.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: customRole.id,
      permission: {
        log: ["read"],
      },
    });
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
    expect(role.role).toBe("test_role");
    expect(role.name).toBe("Test Role");
    expect(role.permission).toEqual({
      agent: ["read"],
      toolPolicy: ["read", "create"],
    });
    expect(role.predefined).toBe(false);
    expect(
      (await OrganizationRoleModel.getById(role.id, organizationId))?.name,
    ).toBe("Test Role");
  });

  test("POST /api/roles rejects a name whose identifier is already taken", async ({
    makeCustomRole,
  }) => {
    await makeCustomRole(organizationId, {
      role: "duplicate_role",
      name: "Duplicate Role",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        // Different display name, same derived identifier.
        name: "Duplicate role",
        permission: { agent: ["read"] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("already taken");
  });

  test("POST /api/roles rejects a reserved predefined name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Admin",
        permission: { agent: ["read"] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("predefined role name");
  });

  test("POST /api/roles rejects a name with no letters or numbers", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: { name: "***", permission: { agent: ["read"] } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "must contain at least one letter or number",
    );
  });

  test("POST /api/roles creates role with empty permissions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Empty Perms",
        permission: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().permission).toEqual({});
  });

  test("POST /api/roles creates role with multiple complex permissions", async () => {
    const complexPermissions = {
      agent: ["read", "create", "update", "delete"],
      toolPolicy: ["read", "create", "update", "delete"],
      log: ["read"],
      mcpServerInstallation: ["read", "create", "delete"],
    };

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

  test("PUT /api/roles/:roleId accepts pairs the no-escalation rule exempts", async ({
    makeCustomRole,
    makeUser,
  }) => {
    // Same divergence as on create: editing a role to switch on a UI-only
    // preference, or leaving a vestigial action in place, is not escalation.
    const author = await makeUser();
    const authorRole = await makeCustomRole(organizationId, {
      role: "role_editor",
      name: "Role Editor",
      permission: { ac: ["read", "update"], agent: ["read"] },
    });
    await db.insert(schema.membersTable).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: author.id,
      role: authorRole.role,
      createdAt: new Date(),
    });
    const target = await makeCustomRole(organizationId, {
      role: "target_role",
      name: "Target Role",
      permission: { agent: ["read"] },
    });
    authenticatedUser = author;

    const response = await app.inject({
      method: "PUT",
      url: `/api/roles/${target.id}`,
      payload: {
        permission: {
          agent: ["read"],
          simpleView: ["enable"],
          invitation: ["read"],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().permission).toEqual({
      agent: ["read"],
      simpleView: ["enable"],
    });
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

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/roles/${existingRole.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/roles/${existingRole.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
  });

  test("DELETE /api/roles/:roleId returns 404 for non-existent role", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/roles/c7528140-07b0-4870-841d-6886a6daeb36",
    });

    expect(response.statusCode).toBe(404);
  });

  // === Enterprise licence gate ===

  describe("without an enterprise licence", () => {
    // Past the small-team threshold with no licence flag: core inactive.
    beforeEach(() => {
      enterpriseTier.setUserCountForTesting(1_000);
    });

    test("refuses to create a custom role", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/roles",
        payload: { name: "Ops Admin", permission: { agent: ["read"] } },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain("enterprise feature");
      expect(
        await OrganizationRoleModel.getByIdentifier(
          "ops_admin",
          organizationId,
        ),
      ).toBeNull();
    });

    test("refuses to update a custom role", async ({ makeCustomRole }) => {
      // An editable role is a creatable role by another name: renaming one and
      // rewriting its permissions would otherwise walk straight around the
      // create gate.
      const role = await makeCustomRole(organizationId, {
        role: "ops_admin",
        name: "Ops Admin",
        permission: { agent: ["read"] },
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/roles/${role.id}`,
        payload: { name: "Ops Superadmin", permission: { apiKey: ["read"] } },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain("enterprise feature");
      expect(
        (await OrganizationRoleModel.getById(role.id, organizationId))?.name,
      ).toBe("Ops Admin");
    });

    test("still deletes a custom role, so an org that outgrew the free tier can unwind", async ({
      makeCustomRole,
    }) => {
      const role = await makeCustomRole(organizationId, {
        role: "ops_admin",
        name: "Ops Admin",
        permission: { agent: ["read"] },
      });
      const response = await app.inject({
        method: "DELETE",
        url: `/api/roles/${role.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(
        await OrganizationRoleModel.getById(role.id, organizationId),
      ).toBeNull();
    });

    test("still lists roles, so the page renders its list dimmed rather than empty", async ({
      makeCustomRole,
    }) => {
      await makeCustomRole(organizationId, {
        role: "ops_admin",
        name: "Ops Admin",
        permission: { agent: ["read"] },
      });

      const response = await app.inject({ method: "GET", url: "/api/roles" });

      expect(response.statusCode).toBe(200);
      expect(
        (response.json() as { data: { role: string }[] }).data.map(
          (r) => r.role,
        ),
      ).toContain("ops_admin");
    });
  });
});
