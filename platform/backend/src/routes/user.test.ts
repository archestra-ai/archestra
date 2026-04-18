import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { allAvailableActions } from "@shared/access-control";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("user routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    // Create member with admin role
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: userRoutes } = await import("./user");
    await app.register(userRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/user/permissions", () => {
    test("returns all permissions for admin user", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);

      const permissions = response.json();

      // Admin should have all available actions
      expect(permissions).toBeDefined();
      expect(permissions.organization).toContain("update");
      expect(permissions.organization).toContain("delete");
      expect(permissions.agent).toBeDefined();
      expect(permissions.toolPolicy).toBeDefined();

      // Verify admin has all resource permissions from allAvailableActions
      for (const [resource, actions] of Object.entries(allAvailableActions)) {
        if (resource === "simpleView") continue; // admin has empty simpleView
        expect(permissions[resource]).toBeDefined();
        for (const action of actions) {
          expect(permissions[resource]).toContain(action);
        }
      }
    });

    test("returns limited permissions for member user", async ({
      makeUser: makeUser2,
      makeMember,
    }) => {
      const memberUser = await makeUser2();
      await makeMember(memberUser.id, organizationId, {
        role: MEMBER_ROLE_NAME,
      });

      // Override the onRequest hook for this specific app instance
      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = memberUser;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: userRoutes } = await import("./user");
      await memberApp.register(userRoutes);

      const response = await memberApp.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);

      const permissions = response.json();
      expect(permissions).toBeDefined();
      // Members should have read access to agents but not delete organization
      expect(permissions.agent).toContain("read");
      expect(permissions.organization).not.toContain("delete");

      await memberApp.close();
    });

    test("returns custom role permissions", async ({
      makeUser: makeUser2,
      makeMember,
      makeCustomRole,
    }) => {
      const customUser = await makeUser2();
      const customRole = await makeCustomRole(organizationId, {
        permission: {
          agent: ["read"],
          toolPolicy: ["read"],
        },
      });

      await makeMember(customUser.id, organizationId, {
        role: customRole.role,
      });

      const customApp = createFastifyInstance();
      customApp.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = customUser;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: userRoutes } = await import("./user");
      await customApp.register(userRoutes);

      const response = await customApp.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);

      const permissions = response.json();
      expect(permissions.agent).toEqual(["read"]);
      expect(permissions.toolPolicy).toEqual(["read"]);
      // Custom role should not have organization permissions
      expect(permissions.organization).toBeUndefined();

      await customApp.close();
    });

    test("returns 404 when user is not a member of any organization", async ({
      makeUser: makeUser2,
    }) => {
      const nonMemberUser = await makeUser2();

      const nonMemberApp = createFastifyInstance();
      nonMemberApp.addHook("onRequest", async (request) => {
        (request as typeof request & { user: unknown }).user = nonMemberUser;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: userRoutes } = await import("./user");
      await nonMemberApp.register(userRoutes);

      const response = await nonMemberApp.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(404);

      await nonMemberApp.close();
    });

    test("admin permissions are unaffected by custom role creation", async ({
      makeCustomRole,
    }) => {
      // Create a custom role with limited permissions (simulates ee test scenario)
      await makeCustomRole(organizationId, {
        permission: {
          agent: ["read"],
          toolPolicy: ["read"],
        },
      });

      // Admin should still have full permissions
      const response = await app.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);

      const permissions = response.json();
      expect(permissions.organization).toContain("update");
      expect(permissions.organization).toContain("delete");
      expect(permissions.agent).toBeDefined();
      expect(permissions.toolPolicy).toBeDefined();
    });
  });
});
