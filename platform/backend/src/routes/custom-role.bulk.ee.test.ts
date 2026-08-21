import { vi } from "vitest";
import { betterAuth, hasPermission } from "@/auth";
import OrganizationRoleModel from "@/models/organization-role";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { deleteOrgRoleMock } = vi.hoisted(() => ({
  deleteOrgRoleMock: vi.fn(),
}));

vi.mock("@/auth");

const hasPermissionMock = vi.mocked(hasPermission);

describe("DELETE /api/roles/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();

    // Not part of the canonical @/auth mock surface — see custom-role.ee.test.ts.
    const api = betterAuth.api as unknown as Record<string, unknown>;
    api.deleteOrgRole = deleteOrgRoleMock;
    deleteOrgRoleMock.mockResolvedValue({ success: true });

    user = await makeAdmin();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    hasPermissionMock.mockResolvedValue({ success: true, error: null });

    const { default: customRoleRoutes } = await import("./custom-role.ee");
    await app.register(customRoleRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({ method: "DELETE", url: "/api/roles/bulk", payload: { ids } });

  test("deletes every named role", async ({ makeCustomRole }) => {
    const first = await makeCustomRole(organizationId, { role: "bulk_role_a" });
    const second = await makeCustomRole(organizationId, {
      role: "bulk_role_b",
    });

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk_role_a" },
        { id: second.id, name: "bulk_role_b" },
      ],
      failed: [],
    });
    expect(deleteOrgRoleMock).toHaveBeenCalledTimes(2);
  });

  /**
   * A role someone still holds cannot be deleted. In a batch that has to be
   * this role's problem — the others in the selection still go.
   */
  test("refuses a role that is still held, and deletes the rest", async ({
    makeCustomRole,
    makeUser,
    makeMember,
  }) => {
    const held = await makeCustomRole(organizationId, { role: "bulk_held" });
    const free = await makeCustomRole(organizationId, { role: "bulk_free" });
    const holder = await makeUser({ email: "holder@bulk.test" });
    await makeMember(holder.id, organizationId, { role: "bulk_held" });

    const response = await bulkDelete([held.id, free.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: free.id, name: "bulk_free" },
    ]);
    expect(response.json().failed).toHaveLength(1);
    expect(response.json().failed[0]).toMatchObject({
      id: held.id,
      name: "bulk_held",
    });
    expect(
      await OrganizationRoleModel.getById(held.id, organizationId),
    ).not.toBeNull();
  });

  test("reports a role from another organization as not found", async ({
    makeCustomRole,
    makeOrganization,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const foreign = await makeCustomRole(otherOrgId, { role: "theirs" });

    const response = await bulkDelete([foreign.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: foreign.id, name: null, error: "Role not found" },
    ]);
    expect(deleteOrgRoleMock).not.toHaveBeenCalled();
    expect(
      await OrganizationRoleModel.getById(foreign.id, otherOrgId),
    ).not.toBeNull();
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
    expect(deleteOrgRoleMock).not.toHaveBeenCalled();
  });
});
