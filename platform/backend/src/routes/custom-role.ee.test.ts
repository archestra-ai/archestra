import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { createOrgRoleMock, updateOrgRoleMock, deleteOrgRoleMock } = vi.hoisted(
  () => ({
    createOrgRoleMock: vi.fn(),
    updateOrgRoleMock: vi.fn(),
    deleteOrgRoleMock: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({
  betterAuth: {
    api: {
      createOrgRole: createOrgRoleMock,
      updateOrgRole: updateOrgRoleMock,
      deleteOrgRole: deleteOrgRoleMock,
    },
  },
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

    const { default: customRoleRoutes } = await import("./custom-role.ee");
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
});
