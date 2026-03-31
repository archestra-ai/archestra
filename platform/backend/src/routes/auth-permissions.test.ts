import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { allAvailableActions } from "@shared/access-control";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Integration tests for auth permission endpoints.
 *
 * Covers the scenarios previously tested via e2e in:
 *   - auth-permissions.spec.ts (admin permissions, has-permission check)
 *   - auth-permissions.ee.spec.ts (custom role with specific permissions)
 *
 * These test the GET /api/user/permissions route with real database state,
 * validating that admin, member, and custom roles receive correct permissions.
 */
describe("auth permissions", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

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

  describe("GET /api/user/permissions - returns all permissions for admin", () => {
    test("admin has every resource and action from allAvailableActions", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);

      const permissions = response.json();

      expect(permissions).toBeDefined();
      expect(permissions.organization).toContain("update");
      expect(permissions.organization).toContain("delete");
      expect(permissions.agent).toBeDefined();
      expect(permissions.toolPolicy).toBeDefined();

      // Admin should have all resource permissions from allAvailableActions
      for (const [resource, actions] of Object.entries(allAvailableActions)) {
        if (resource === "simpleView") continue; // admin has empty simpleView
        expect(permissions[resource]).toBeDefined();
        for (const action of actions) {
          expect(permissions[resource]).toContain(action);
        }
      }
    });
  });

  describe("POST /api/auth/organization/has-permission - admin can access all resources", () => {
    test("admin permissions include every action for all resources", async () => {
      // Instead of calling the better-auth has-permission endpoint directly,
      // we verify the same invariant: an admin's resolved permissions contain
      // every action from allAvailableActions.
      const response = await app.inject({
        method: "GET",
        url: "/api/user/permissions",
      });

      expect(response.statusCode).toBe(200);
      const permissions = response.json();

      // Verify that for every resource/action pair in allAvailableActions,
      // the admin's permissions include it (mirrors the e2e has-permission check).
      for (const [resource, actions] of Object.entries(allAvailableActions)) {
        if (resource === "simpleView") continue;
        for (const action of actions) {
          expect(
            permissions[resource],
            `Admin should have "${action}" on "${resource}"`,
          ).toContain(action);
        }
      }
    });
  });

  describe("POST /api/auth/organization/has-permission - custom role with specific permissions", () => {
    test("custom role only has the permissions explicitly granted", async ({
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

      // Custom role should only have the explicitly granted permissions
      expect(permissions.agent).toEqual(["read"]);
      expect(permissions.toolPolicy).toEqual(["read"]);

      // Custom role should NOT have organization-level permissions
      expect(permissions.organization).toBeUndefined();

      // Custom role should NOT have other resource permissions
      expect(permissions.mcpServer).toBeUndefined();
      expect(permissions.team).toBeUndefined();

      await customApp.close();
    });

    test("member role has read access but not admin actions", async ({
      makeUser: makeUser2,
      makeMember,
    }) => {
      const memberUser = await makeUser2();
      await makeMember(memberUser.id, organizationId, {
        role: MEMBER_ROLE_NAME,
      });

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

      // Members should have read access to agents
      expect(permissions.agent).toContain("read");

      // Members should NOT have delete on organization
      expect(permissions.organization).not.toContain("delete");

      await memberApp.close();
    });
  });
});
