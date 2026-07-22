import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import { AgentModel, AgentToolModel, McpServerModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { connectAndGetToolsMock } = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    invalidateConnectionsForServer: vi.fn(),
    inspectServer: vi.fn(),
  },
}));

vi.mock("@/auth/utils");

const hasPermissionMock = vi.mocked(hasPermission);
const userHasPermissionMock = vi.mocked(userHasPermission);

/**
 * Admin pre-provisioning of a personal install for another user: a request
 * with `scope: "personal"` and an explicit `userId` must create (or return)
 * the install owned by that target user, not by the authenticated caller.
 */
describe("MCP Server Install - explicit target user", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.clearAllMocks();
    // Caller passes every permission gate unless a test narrows it.
    hasPermissionMock.mockResolvedValue({ success: true, error: null });
    userHasPermissionMock.mockResolvedValue(true);
    connectAndGetToolsMock.mockResolvedValue([]);

    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function install(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/mcp_server",
      // `name` is overwritten from the catalog row; the schema still requires it.
      payload: { name: "install", serverType: "remote", ...payload },
    });
  }

  async function makeOrgCatalog(
    makeInternalMcpCatalog: (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string }>,
    authorId: string,
  ) {
    return makeInternalMcpCatalog({
      organizationId,
      authorId,
      scope: "org",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
    });
  }

  describe("installing for another user", () => {
    test("admin installing with userId creates the personal install for the target user", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const target = await makeUser();
      await makeMember(admin.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);

      currentUser = admin;
      const res = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.scope).toBe("personal");
      expect(body.ownerId).toBe(target.id);
      expect(body.users).toContain(target.id);
    });

    test("discovered tools are assigned to the target user's personal gateway, not the caller's", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const target = await makeUser();
      await makeMember(admin.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);
      connectAndGetToolsMock.mockResolvedValue([
        {
          name: "list_items",
          description: "",
          inputSchema: { type: "object" },
        },
      ]);

      currentUser = admin;
      const res = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });
      expect(res.statusCode).toBe(200);

      const targetGateway = await AgentModel.getPersonalMcpGateway(
        target.id,
        organizationId,
      );
      if (!targetGateway) throw new Error("target gateway was not created");
      expect(
        await AgentToolModel.findToolIdsByAgent(targetGateway.id),
      ).toHaveLength(1);

      const callerGateway = await AgentModel.getPersonalMcpGateway(
        admin.id,
        organizationId,
      );
      if (callerGateway) {
        expect(
          await AgentToolModel.findToolIdsByAgent(callerGateway.id),
        ).toHaveLength(0);
      }
    });

    test("admin's own personal install does not shadow an install requested for another user", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const target = await makeUser();
      await makeMember(admin.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);

      currentUser = admin;
      const own = await install({ catalogId: catalog.id, scope: "personal" });
      expect(own.statusCode).toBe(200);
      expect(own.json().ownerId).toBe(admin.id);

      // Duplicate detection must key on the effective target user, not the
      // caller — the admin's own install is not a duplicate of the target's.
      const forTarget = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });

      expect(forTarget.statusCode).toBe(200);
      const body = forTarget.json();
      expect(body.id).not.toBe(own.json().id);
      expect(body.ownerId).toBe(target.id);
    });

    test("repeat install for the same target user idempotently returns the target's existing install", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const target = await makeUser();
      await makeMember(admin.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);
      connectAndGetToolsMock.mockResolvedValue([
        {
          name: "list_items",
          description: "",
          inputSchema: { type: "object" },
        },
      ]);

      currentUser = admin;
      const first = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });
      expect(first.statusCode).toBe(200);

      const second = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);
      expect(second.json().ownerId).toBe(target.id);

      // The duplicate-return branch re-assigns catalog tools; they must land
      // on the target's gateway (idempotently), never the caller's.
      const targetGateway = await AgentModel.getPersonalMcpGateway(
        target.id,
        organizationId,
      );
      if (!targetGateway) throw new Error("target gateway was not created");
      expect(
        await AgentToolModel.findToolIdsByAgent(targetGateway.id),
      ).toHaveLength(1);
      const callerGateway = await AgentModel.getPersonalMcpGateway(
        admin.id,
        organizationId,
      );
      if (callerGateway) {
        expect(
          await AgentToolModel.findToolIdsByAgent(callerGateway.id),
        ).toHaveLength(0);
      }
    });

    test("a non-admin caller targeting another user gets 403 and no install is created", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const caller = await makeUser();
      const target = await makeUser();
      await makeMember(caller.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, caller.id);
      hasPermissionMock.mockResolvedValue({ success: false, error: null });
      userHasPermissionMock.mockResolvedValue(false);

      currentUser = caller;
      const res = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: target.id,
      });

      expect(res.statusCode).toBe(403);
      expect(await McpServerModel.findByCatalogId(catalog.id)).toHaveLength(0);
    });

    test("a non-admin caller may pass their own id explicitly", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const caller = await makeUser();
      await makeMember(caller.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, caller.id);
      hasPermissionMock.mockResolvedValue({ success: false, error: null });
      userHasPermissionMock.mockResolvedValue(false);

      currentUser = caller;
      const res = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: caller.id,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ownerId).toBe(caller.id);
    });

    test("a target userId with a non-personal scope is rejected", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const target = await makeUser();
      await makeMember(admin.id, organizationId);
      await makeMember(target.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);

      currentUser = admin;
      const res = await install({
        catalogId: catalog.id,
        scope: "org",
        userId: target.id,
      });

      expect(res.statusCode).toBe(400);
    });

    test("a target user outside the organization is rejected", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const admin = await makeUser();
      const outsider = await makeUser();
      await makeMember(admin.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, admin.id);

      currentUser = admin;
      const res = await install({
        catalogId: catalog.id,
        scope: "personal",
        userId: outsider.id,
      });

      expect(res.statusCode).toBe(404);
      expect(await McpServerModel.findByCatalogId(catalog.id)).toHaveLength(0);
    });
  });

  describe("installing for oneself (unchanged behavior)", () => {
    test("a personal install without userId is owned by the caller and feeds the caller's gateway", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const caller = await makeUser();
      await makeMember(caller.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, caller.id);
      connectAndGetToolsMock.mockResolvedValue([
        {
          name: "list_items",
          description: "",
          inputSchema: { type: "object" },
        },
      ]);

      currentUser = caller;
      const res = await install({ catalogId: catalog.id, scope: "personal" });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ownerId).toBe(caller.id);
      expect(body.users).toContain(caller.id);

      const gateway = await AgentModel.getPersonalMcpGateway(
        caller.id,
        organizationId,
      );
      if (!gateway) throw new Error("caller gateway was not created");
      expect(await AgentToolModel.findToolIdsByAgent(gateway.id)).toHaveLength(
        1,
      );
    });

    test("repeating a personal install without userId returns the caller's existing install", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const caller = await makeUser();
      await makeMember(caller.id, organizationId);
      const catalog = await makeOrgCatalog(makeInternalMcpCatalog, caller.id);

      currentUser = caller;
      const first = await install({ catalogId: catalog.id, scope: "personal" });
      expect(first.statusCode).toBe(200);

      const second = await install({
        catalogId: catalog.id,
        scope: "personal",
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);
      expect(second.json().ownerId).toBe(caller.id);
    });
  });
});
