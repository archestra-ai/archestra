import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { allAvailableActions } from "@archestra/shared/access-control";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
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
      expect(permissions.mcpRegistry).toBeDefined();

      // Verify admin has all resource permissions from allAvailableActions
      for (const [resource, actions] of Object.entries(allAvailableActions)) {
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
          mcpRegistry: ["read"],
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
      expect(permissions.mcpRegistry).toEqual(["read"]);
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
          mcpRegistry: ["read"],
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
      expect(permissions.mcpRegistry).toBeDefined();
    });
  });
  describe("GET /api/user/impersonable", () => {
    type Page = {
      data: Array<{ id: string; name: string; role: string | null }>;
      pagination: { hasNext: boolean; nextCursor: string | null };
    };

    async function getPage(query = "") {
      const response = await app.inject({
        method: "GET",
        url: `/api/user/impersonable${query ? `?${query}` : ""}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as Page;
    }

    test("lists org members with their role, excluding the caller and other orgs", async ({
      makeUser,
      makeMember,
      makeOrganization,
    }) => {
      const memberUser = await makeUser({ name: "Bob Member" });
      await makeMember(memberUser.id, organizationId, {
        role: MEMBER_ROLE_NAME,
      });
      const adminUser = await makeUser({ name: "Carol Admin", role: "admin" });
      await makeMember(adminUser.id, organizationId, {
        role: ADMIN_ROLE_NAME,
      });
      const elsewhere = await makeOrganization();
      const foreign = await makeUser({ name: "Dan Foreign" });
      await makeMember(foreign.id, elsewhere.id);

      const page = await getPage();

      // other admins are impersonable — viewing-as an admin is the role debugger
      expect(page.data.map((c) => [c.id, c.role])).toEqual([
        [memberUser.id, MEMBER_ROLE_NAME],
        [adminUser.id, ADMIN_ROLE_NAME],
      ]);
      expect(page.pagination.hasNext).toBe(false);
    });

    test("cursor pages cover every candidate once, including name ties", async ({
      makeUser,
      makeMember,
    }) => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index++) {
        const candidate = await makeUser({
          name: index < 3 ? "Same name" : `Candidate ${index}`,
        });
        await makeMember(candidate.id, organizationId);
        ids.push(candidate.id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = await getPage(
          `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((row) => row.id));
        cursor = page.pagination.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(ids.length);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    test("search matches name or email beyond the first page", async ({
      makeUser,
      makeMember,
    }) => {
      for (let index = 0; index < 25; index++) {
        const filler = await makeUser({ name: `Filler ${index}` });
        await makeMember(filler.id, organizationId);
      }
      const target = await makeUser({
        name: "Zelda Target",
        email: "zelda.target@example.com",
      });
      await makeMember(target.id, organizationId);

      const firstPage = await getPage();
      expect(firstPage.data).toHaveLength(20);
      expect(firstPage.pagination.hasNext).toBe(true);
      expect(firstPage.data.map((row) => row.id)).not.toContain(target.id);

      for (const search of ["zelda", "target%40example"]) {
        const page = await getPage(`search=${search}`);
        expect(page.data.map((row) => row.id)).toEqual([target.id]);
      }
      expect(
        (await getPage(`search=${encodeURIComponent(user.email)}`)).data,
      ).toEqual([]);
    });

    test("rejects a page size above 100", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/user/impersonable?limit=101",
      });
      expect(response.statusCode).toBe(400);
    });

    test("returns 403 when impersonation is disabled", async () => {
      const previous = config.auth.disableImpersonation;
      config.auth.disableImpersonation = true;
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/user/impersonable",
        });
        expect(response.statusCode).toBe(403);
      } finally {
        config.auth.disableImpersonation = previous;
      }
    });
  });
});
