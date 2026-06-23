import { SupportedProviders } from "@archestra/shared";
import * as Sentry from "@sentry/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { vi } from "vitest";
import config from "@/config";
import { afterEach, describe, expect, test } from "@/test";
import { Authnz } from "./middleware";

// Mock Sentry
vi.mock("@sentry/node", () => ({
  setUser: vi.fn(),
}));

describe("Authnz", () => {
  const authnz = new Authnz();

  describe("shouldSkipAuthCheck", () => {
    test("should skip auth for ACME challenge paths", async () => {
      const mockRequest = {
        url: "/.well-known/acme-challenge/test-token",
        method: "GET",
        headers: {},
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      // The middleware should not call reply.status() for ACME challenge paths
      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    test("should skip auth for various ACME challenge token formats", async () => {
      const acmeUrls = [
        "/.well-known/acme-challenge/",
        "/.well-known/acme-challenge/simple-token",
        "/.well-known/acme-challenge/complex-token-with-numbers-123",
        "/.well-known/acme-challenge/very_long_token_with_underscores_and_hyphens-123-456_789",
      ];

      for (const url of acmeUrls) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should skip auth for OPTIONS and HEAD requests", async () => {
      const methods = ["OPTIONS", "HEAD"];

      for (const method of methods) {
        const mockRequest = {
          url: "/some/protected/path",
          method,
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should skip auth for existing whitelisted paths", async () => {
      // Generate LLM proxy paths dynamically from SupportedProviders
      const llmProxyPaths = SupportedProviders.map(
        (provider) => `/v1/${provider}/completions`,
      );

      const whitelistedPaths = [
        "/api/auth/session",
        ...llmProxyPaths,
        "/openapi.json",
        "/health",
        "/ready",
        "/metrics",
        "/api/archestra-catalog/category",
        "/api/archestra-catalog/search?q=foo",
      ];

      for (const url of whitelistedPaths) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should skip auth for all supported LLM provider routes", async () => {
      // Test various path patterns for each provider
      for (const provider of SupportedProviders) {
        const providerPaths = [
          `/v1/${provider}`,
          `/v1/${provider}/`,
          `/v1/${provider}/chat/completions`,
          `/v1/${provider}/some-agent-id/chat/completions`,
        ];

        for (const url of providerPaths) {
          const mockRequest = {
            url,
            method: "POST",
            headers: {},
          } as FastifyRequest;

          const mockReply = {
            status: vi.fn().mockReturnThis(),
            send: vi.fn(),
          } as unknown as FastifyReply;

          await authnz.handle(mockRequest, mockReply);

          expect(mockReply.status).not.toHaveBeenCalled();
          expect(mockReply.send).not.toHaveBeenCalled();
        }
      }
    });

    test("should skip auth for model router proxy routes", async () => {
      const modelRouterPaths = [
        "/v1/model-router/models",
        "/v1/model-router/chat/completions",
        "/v1/model-router/responses",
        "/v1/model-router/embeddings",
        "/v1/model-router/some-agent-id/models",
        "/v1/model-router/some-agent-id/chat/completions",
        "/v1/model-router/some-agent-id/responses",
        "/v1/model-router/some-agent-id/embeddings",
      ];

      for (const url of modelRouterPaths) {
        const mockRequest = {
          url,
          method: "POST",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should skip auth for GET requests to public SSO providers endpoint only", async () => {
      const publicSsoProviderUrl = "/api/identity-providers/public";

      const mockRequest = {
        url: publicSsoProviderUrl,
        method: "GET",
        headers: {},
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    test("should skip auth for GET requests to public config endpoint", async () => {
      const mockRequest = {
        url: "/api/config/public",
        method: "GET",
        headers: {},
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    test("should NOT skip auth for GET requests to full SSO providers endpoint (contains secrets)", async () => {
      const mockRequest = {
        url: "/api/identity-providers",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: {
            operationId: "GetIdentityProviders",
          },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      // Should throw ApiError for unauthenticated requests to full providers endpoint
      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should NOT skip auth for non-GET requests to SSO providers endpoint", async () => {
      const nonGetMethods = ["POST", "PUT", "DELETE", "PATCH"];

      for (const method of nonGetMethods) {
        const mockRequest = {
          url: "/api/identity-providers",
          method,
          headers: {},
          routeOptions: {
            schema: {
              operationId: "IdentityProviderOperation",
            },
          },
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        // Should throw ApiError for unauthenticated non-GET requests
        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
      }
    });

    test("should skip auth for GET requests to public appearance endpoint", async () => {
      const publicAppearanceUrl = "/api/organization/appearance-settings";

      const mockRequest = {
        url: publicAppearanceUrl,
        method: "GET",
        headers: {},
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    test("should NOT skip auth for non-GET requests to public appearance endpoint", async () => {
      const nonGetMethods = ["POST", "PUT", "DELETE", "PATCH"];

      for (const method of nonGetMethods) {
        const mockRequest = {
          url: "/api/organization/appearance-settings",
          method,
          headers: {},
          routeOptions: {
            schema: {
              operationId: "AppearanceOperation",
            },
          },
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        // Should throw ApiError for unauthenticated non-GET requests
        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
      }
    });

    test("should NOT skip auth for GET requests to individual SSO provider endpoints", async () => {
      const individualProviderUrls = [
        "/api/identity-providers/some-id",
        "/api/identity-providers/gB4pGSDirn3hhmRJy3hCVMzRFSOhPtl3",
        "/api/identity-providers/123",
      ];

      for (const url of individualProviderUrls) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
          routeOptions: {
            schema: {
              operationId: "GetIdentityProvider",
            },
          },
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
      }
    });

    test("should skip auth for incoming email webhook routes", async () => {
      const webhookUrls = [
        "/api/webhooks/incoming-email",
        "/api/webhooks/incoming-email?validationToken=abc123",
      ];

      for (const url of webhookUrls) {
        const mockRequest = {
          url,
          method: "POST",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should NOT skip auth for incoming email setup endpoint (legacy)", async () => {
      const mockRequest = {
        url: "/api/webhooks/incoming-email/setup",
        method: "POST",
        headers: {},
        routeOptions: {
          schema: {
            operationId: "LegacyIncomingEmailSetup",
          },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      // Should throw ApiError for unauthenticated requests to setup endpoint
      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should skip auth for OAuth well-known discovery endpoints", async () => {
      const oauthWellKnownUrls = [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource/v1/mcp/some-profile-id",
        "/.well-known/oauth-protected-resource/v1/mcp/another-id",
      ];

      for (const url of oauthWellKnownUrls) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should skip auth for OAuth consent page paths", async () => {
      const oauthConsentUrls = [
        "/oauth/consent",
        "/oauth/consent?client_id=abc&scope=mcp",
      ];

      for (const url of oauthConsentUrls) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    test("should NOT skip auth for similar but different paths", async () => {
      const protectedPaths = [
        "/.well-known/something-else",
        "/.well-known-acme-challenge/test", // missing slash
        "/well-known/acme-challenge/test", // missing leading dot
        "/api/protected-endpoint",
      ];

      for (const url of protectedPaths) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
          routeOptions: {
            schema: {
              operationId: "SomeProtectedRoute",
            },
          },
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        // Should throw ApiError for unauthenticated requests to protected paths
        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
      }
    });
  });

  describe("authMethod stamping", () => {
    /**
     * These tests verify that populateUserInfo stamps request.authMethod
     * with "session" or "api_key" after successful authentication.
     * We spy on betterAuth and UserModel to control the auth flow, and restore
     * all spies in afterEach so other tests are unaffected.
     */
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test("sets authMethod=session when session auth succeeds", async () => {
      const { betterAuth } = await import("@/auth");
      const { UserModel } = await import("@/models");
      const { requiredEndpointPermissionsMap } = await import(
        "@archestra/shared/access-control"
      );

      const fakeOrgId = "org-session-test";
      const fakeUserId = "user-session-test";

      vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
        user: { id: fakeUserId },
        session: { id: "session-abc" },
      } as Awaited<ReturnType<typeof betterAuth.api.getSession>>);

      vi.spyOn(UserModel, "getById").mockResolvedValue({
        id: fakeUserId,
        organizationId: fakeOrgId,
        name: "Test User",
        email: "test@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        image: null,
        twoFactorEnabled: null,
      } as Awaited<ReturnType<typeof UserModel.getById>>);

      // Allow any authenticated user by giving the operationId empty permissions.
      // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
      const testOpId = "__authMethodSessionTest__" as any;
      // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
      (requiredEndpointPermissionsMap as any)[testOpId] = {};

      const request = {
        url: "/api/some-route",
        method: "GET",
        headers: { cookie: "session=abc" },
        id: "req-session-test",
        routeOptions: { schema: { operationId: testOpId } },
      } as unknown as FastifyRequest;
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(request, reply);

      expect((request as unknown as { authMethod: string }).authMethod).toBe(
        "session",
      );

      // biome-ignore lint/suspicious/noExplicitAny: cleanup
      delete (requiredEndpointPermissionsMap as any)[testOpId];
    });

    test("sets authMethod=api_key when API key auth succeeds", async () => {
      const { betterAuth } = await import("@/auth");
      const { UserModel } = await import("@/models");
      const { requiredEndpointPermissionsMap } = await import(
        "@archestra/shared/access-control"
      );

      const fakeOrgId = "org-apikey-test";
      const fakeUserId = "user-apikey-test";
      const fakeApiKey = "archestra_test_key";

      // Session fails → falls through to API key
      vi.spyOn(betterAuth.api, "getSession").mockRejectedValue(
        new Error("No active organization"),
      );
      vi.spyOn(betterAuth.api, "verifyApiKey").mockResolvedValue({
        valid: true,
        key: { referenceId: fakeUserId },
      } as Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>);

      vi.spyOn(UserModel, "getById").mockResolvedValue({
        id: fakeUserId,
        organizationId: fakeOrgId,
        name: "API User",
        email: "api@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        image: null,
        twoFactorEnabled: null,
      } as Awaited<ReturnType<typeof UserModel.getById>>);

      // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
      const testOpId = "__authMethodApiKeyTest__" as any;
      // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
      (requiredEndpointPermissionsMap as any)[testOpId] = {};

      const request = {
        url: "/api/some-route",
        method: "GET",
        headers: { authorization: fakeApiKey },
        id: "req-apikey-test",
        routeOptions: { schema: { operationId: testOpId } },
      } as unknown as FastifyRequest;
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(request, reply);

      expect((request as unknown as { authMethod: string }).authMethod).toBe(
        "api_key",
      );

      // biome-ignore lint/suspicious/noExplicitAny: cleanup
      delete (requiredEndpointPermissionsMap as any)[testOpId];
    });
  });

  describe("setSentryUserContext", () => {
    test("should set Sentry user context with all available fields", () => {
      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
      };

      const mockRequest = {
        headers: {
          "x-forwarded-for": "192.168.1.1, 10.0.0.1",
        },
        ip: "127.0.0.1",
        // biome-ignore lint/suspicious/noExplicitAny: test...
      } as any;

      authnz.setSentryUserContext(mockUser, mockRequest);

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: "user-123",
        email: "test@example.com",
        username: "Test User",
        ip_address: "192.168.1.1",
      });
    });

    test("should use email as username when name is not available", () => {
      const mockUser = {
        id: "user-456",
        email: "another@example.com",
      };

      const mockRequest = {
        headers: {},
        ip: "127.0.0.1",
      } as FastifyRequest;

      authnz.setSentryUserContext(mockUser, mockRequest);

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: "user-456",
        email: "another@example.com",
        username: "another@example.com",
        ip_address: "127.0.0.1",
      });
    });

    test("should extract IP from x-real-ip header", () => {
      const mockUser = { id: "user-789" };

      const mockRequest = {
        headers: {
          "x-real-ip": "203.0.113.0",
        },
        ip: "127.0.0.1",
        // biome-ignore lint/suspicious/noExplicitAny: test...
      } as any;

      authnz.setSentryUserContext(mockUser, mockRequest);

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: "user-789",
        email: undefined,
        username: undefined,
        ip_address: "203.0.113.0",
      });
    });

    test("should handle errors silently", () => {
      const mockUser = { id: "user-error" };
      const mockRequest = {} as FastifyRequest;

      // Mock Sentry.setUser to throw an error
      vi.mocked(Sentry.setUser).mockImplementationOnce(() => {
        throw new Error("Sentry error");
      });

      // Should not throw
      expect(() => {
        authnz.setSentryUserContext(mockUser, mockRequest);
      }).not.toThrow();
    });
  });

  describe("MCP App connector auth", () => {
    const CONNECTOR_URL = "/api/mcp/app/11111111-1111-1111-1111-111111111111";
    const makeReply = () =>
      ({
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        header: vi.fn().mockReturnThis(),
      }) as unknown as FastifyReply;

    test("stands down for a Bearer connector request (validated in-route)", async () => {
      const mockRequest = {
        url: CONNECTOR_URL,
        method: "POST",
        headers: { authorization: "Bearer connector-token" },
      } as FastifyRequest;
      const mockReply = makeReply();

      await authnz.handle(mockRequest, mockReply);

      // Skipped here so the route validates the token; no auth failure, no challenge.
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
      expect(mockReply.header).not.toHaveBeenCalled();
    });

    test("challenges a credential-less connector request (RFC 9728) when apps are enabled", async () => {
      const original = config.apps.enabled;
      (config.apps as { enabled: boolean }).enabled = true;
      try {
        const mockRequest = {
          url: CONNECTOR_URL,
          method: "POST",
          headers: { host: "localhost:9000" },
        } as FastifyRequest;
        const mockReply = makeReply();

        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
        expect(mockReply.header).toHaveBeenCalledWith(
          "WWW-Authenticate",
          expect.stringContaining("resource_metadata"),
        );
      } finally {
        (config.apps as { enabled: boolean }).enabled = original;
      }
    });

    test("does not challenge a connector request when apps are disabled (dark)", async () => {
      const original = config.apps.enabled;
      (config.apps as { enabled: boolean }).enabled = false;
      try {
        const mockRequest = {
          url: CONNECTOR_URL,
          method: "POST",
          headers: { host: "localhost:9000" },
        } as FastifyRequest;
        const mockReply = makeReply();

        await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
          "Unauthenticated",
        );
        expect(mockReply.header).not.toHaveBeenCalled();
      } finally {
        (config.apps as { enabled: boolean }).enabled = original;
      }
    });
  });
});
