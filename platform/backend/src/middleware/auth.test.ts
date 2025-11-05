import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "./auth";

describe("AuthMiddleware", () => {
  describe("shouldSkipAuthCheck", () => {
    it("should skip auth for ACME challenge paths", async () => {
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
      await authMiddleware.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it("should skip auth for various ACME challenge token formats", async () => {
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

        await authMiddleware.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should skip auth for OPTIONS and HEAD requests", async () => {
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

        await authMiddleware.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should skip auth for existing whitelisted paths", async () => {
      const whitelistedPaths = [
        "/api/auth/session",
        "/v1/openai/completions",
        "/v1/anthropic/messages",
        "/v1/gemini/generate",
        "/json",
        "/openapi.json",
        "/health",
        "/api/features",
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

        await authMiddleware.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should NOT skip auth for similar but different paths", async () => {
      const protectedPaths = [
        "/.well-known/something-else",
        "/.well-known-acme-challenge/test", // missing slash
        "/well-known/acme-challenge/test", // missing leading dot
        "/api/protected-endpoint",
        "/metrics",
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

        await authMiddleware.handle(mockRequest, mockReply);

        // Should return 401 for unauthenticated requests to protected paths
        expect(mockReply.status).toHaveBeenCalledWith(401);
      }
    });
  });
});
