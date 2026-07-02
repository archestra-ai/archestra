import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { vi } from "vitest";

// @/auth (better-auth + hasPermission) is the external auth boundary; the
// access-control map and @/auth/utils are configuration/logic seams. The
// database (UserModel / ServiceAccountModel) is NOT mocked — it's real PGlite.
vi.mock("@/auth");
vi.mock("@/auth/utils");
vi.mock("@archestra/shared/access-control", () => ({
  requiredEndpointPermissionsMap: {
    createAgent: { agent: ["create"] },
    getAgents: { agent: ["read"] },
  },
  allAvailableActions: {},
  editorPermissions: {},
  memberPermissions: {},
}));

import { betterAuth, hasPermission } from "@/auth";
import { UserModel } from "@/models";
import {
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";
import { ApiError } from "@/types";
import { Authnz } from "./middleware";
import { authPlugin } from "./plugin";

const mockBetterAuth = betterAuth as unknown as {
  api: {
    getSession: MockedFunction<typeof betterAuth.api.getSession>;
    verifyApiKey: MockedFunction<typeof betterAuth.api.verifyApiKey>;
  };
};

const mockHasPermission = hasPermission as MockedFunction<typeof hasPermission>;

type Session = Awaited<ReturnType<typeof betterAuth.api.getSession>>;

// The middleware calls getSession with `returnHeaders: true`, so the resolved
// value is `{ response, headers }`. Wrap the bare session shape the tests build
// so the mock matches what better-auth actually returns.
const sessionResult = (session: unknown): Session =>
  ({ response: session, headers: new Headers() }) as unknown as Session;
type ApiKey = Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>["key"];

const mockReply = () =>
  ({
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    header: vi.fn().mockReturnThis(),
  }) as unknown as FastifyReply;

describe("authPlugin integration", () => {
  const authnz = new Authnz();

  beforeEach(() => {
    // Restore any vi.spyOn fault-injection (e.g. a rejecting getById) so it
    // doesn't leak into later tests.
    vi.restoreAllMocks();
  });

  describe("authentication", () => {
    test("should allow authenticated session users", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;
      const reply = mockReply();

      await authnz.handle(request, reply);

      expect(reply.status).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });

    test("forwards better-auth's refreshed cookie-cache Set-Cookie to the reply", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const refreshedCookie =
        "archestra.session_data=cached; Max-Age=60; Path=/";
      const authHeaders = new Headers();
      authHeaders.append("set-cookie", refreshedCookie);
      mockBetterAuth.api.getSession.mockResolvedValue({
        response: {
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        },
        headers: authHeaders,
      } as unknown as Session);
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;
      const reply = mockReply();

      await authnz.handle(request, reply);

      expect(reply.header).toHaveBeenCalledWith("set-cookie", [
        refreshedCookie,
      ]);
    });

    test("should allow valid API key authentication", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({ referenceId: user.id }),
      });
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer api-key-123" },
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;
      const reply = mockReply();

      await authnz.handle(request, reply);

      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
      expect(reply.status).not.toHaveBeenCalled();
    });

    test("should return 401 for invalid session", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(sessionResult(null));

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should return 401 for invalid API key", async () => {
      mockBetterAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: false,
        error: null,
        key: null,
      });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer invalid-key" },
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        "Unauthenticated",
      );
    });
  });

  describe("authorization", () => {
    test("should return 403 for insufficient permissions", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );
      mockHasPermission.mockResolvedValue({ success: false, error: null });

      const request = {
        url: "/api/agents",
        method: "POST",
        headers: {},
        routeOptions: { schema: { operationId: "createAgent" } },
      } as unknown as FastifyRequest;

      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        "Forbidden",
      );
    });

    test("should return 403 for routes without operationId", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );

      const request = {
        url: "/api/unknown",
        method: "GET",
        headers: {},
        routeOptions: { schema: {} }, // No operationId
      } as unknown as FastifyRequest;

      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        "Forbidden",
      );
    });

    test("should check specific permissions for configured routes", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "POST",
        headers: {},
        routeOptions: { schema: { operationId: "createAgent" } },
      } as unknown as FastifyRequest;

      await authnz.handle(request, mockReply());

      expect(mockHasPermission).toHaveBeenCalledWith(
        { agent: ["create"] },
        expect.objectContaining({}),
        undefined,
      );
    });
  });

  describe("user info population", () => {
    test("should populate user and organizationId from session", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      await authnz.handle(request, mockReply());

      expect(request.user).toEqual(
        expect.objectContaining({ id: user.id, name: user.name }),
      );
      // organizationId is not carried on request.user
      expect(
        (request.user as unknown as { organizationId?: string }).organizationId,
      ).toBeUndefined();
      expect(request.organizationId).toBe(org.id);
    });

    test("should populate organizationId from the member record (not the session)", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      // The middleware always derives organizationId from UserModel.getById
      // (the member join), never from session.activeOrganizationId.
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: {}, // No activeOrganizationId
        }),
      );
      mockHasPermission.mockResolvedValue({ success: true, error: null });

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      await authnz.handle(request, mockReply());

      expect(request.user).toEqual(
        expect.objectContaining({ id: user.id, name: user.name }),
      );
      expect(request.organizationId).toBe(org.id);
    });
  });

  describe("edge cases", () => {
    test("should handle auth service errors gracefully", async () => {
      mockBetterAuth.api.getSession.mockRejectedValue(
        new Error("Auth service down"),
      );
      mockBetterAuth.api.verifyApiKey.mockRejectedValue(
        new Error("API key service down"),
      );

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer some-key" },
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should reject with 401 when user population fails", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockBetterAuth.api.getSession.mockResolvedValue(
        sessionResult({
          user: { id: user.id },
          session: { activeOrganizationId: org.id },
        }),
      );
      mockHasPermission.mockResolvedValue({ success: true, error: null });
      // Simulate the user lookup blowing up during population.
      vi.spyOn(UserModel, "getById").mockRejectedValue(new Error("DB error"));

      const request = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: { schema: { operationId: "getAgents" } },
      } as unknown as FastifyRequest;

      // Should throw 401 when user info cannot be populated
      await expect(authnz.handle(request, mockReply())).rejects.toThrow(
        ApiError,
      );
    });
  });

  describe("plugin registration", () => {
    test("should register decorators and hooks", () => {
      const mockApp = {
        decorateRequest: vi.fn(),
        addHook: vi.fn(),
      } as unknown as FastifyInstance;

      authPlugin(mockApp);

      expect(mockApp.decorateRequest).toHaveBeenCalledWith("user");
      expect(mockApp.decorateRequest).toHaveBeenCalledWith("organizationId");
      expect(mockApp.addHook).toHaveBeenCalledWith(
        "preHandler",
        expect.any(Function),
      );
    });
  });
});

function makeApiKey(
  overrides: Partial<NonNullable<ApiKey>> = {},
): NonNullable<ApiKey> {
  return {
    id: "api-key-123",
    configId: "default",
    name: null,
    start: null,
    prefix: null,
    referenceId: "user1",
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: false,
    rateLimitTimeWindow: null,
    rateLimitMax: null,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: null,
    permissions: null,
    ...overrides,
  };
}
