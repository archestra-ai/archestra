import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import oauthServerRoutes from "./oauth-server";

describe("OAuth Server - Well-Known Endpoints", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(oauthServerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /.well-known/oauth-protected-resource/*", () => {
    test("returns correct metadata with dynamic Host-based URLs", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/v1/mcp/some-profile-id",
        headers: { host: "localhost:9000" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.resource).toBe(
        "http://localhost:9000/v1/mcp/some-profile-id",
      );
      expect(body.authorization_servers).toEqual(["http://localhost:9000"]);
      expect(body.scopes_supported).toEqual(["mcp"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
    });

    test("uses Docker host when Host header is from Docker", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/v1/mcp/test-id",
        headers: { host: "host.docker.internal:9000" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.resource).toBe(
        "http://host.docker.internal:9000/v1/mcp/test-id",
      );
      expect(body.authorization_servers).toEqual([
        "http://host.docker.internal:9000",
      ]);
    });
  });

  describe("GET /.well-known/oauth-authorization-server", () => {
    test("returns correct OAuth 2.1 authorization server metadata", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        headers: { host: "localhost:9000" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // issuer and authorization_endpoint use the frontend base URL (browser-facing)
      expect(body.issuer).toBe("http://localhost:3000/");
      expect(body.authorization_endpoint).toBe(
        "http://localhost:3000/api/auth/oauth2/authorize",
      );
      // token, registration, and jwks use the request Host (server-to-server)
      expect(body.token_endpoint).toBe(
        "http://localhost:9000/api/auth/oauth2/token",
      );
      expect(body.registration_endpoint).toBe(
        "http://localhost:9000/api/auth/oauth2/register",
      );
      expect(body.jwks_uri).toBe("http://localhost:9000/api/auth/jwks");
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.token_endpoint_auth_methods_supported).toContain("none");
    });

    test("includes all required OAuth 2.1 metadata fields", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        headers: { host: "localhost:9000" },
      });

      const body = response.json();
      const requiredFields = [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
        "jwks_uri",
        "response_types_supported",
        "grant_types_supported",
        "code_challenge_methods_supported",
        "token_endpoint_auth_methods_supported",
        "scopes_supported",
      ];

      for (const field of requiredFields) {
        expect(body).toHaveProperty(field);
      }
    });

    test("uses dynamic Host header for Docker networking", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        headers: { host: "host.docker.internal:9000" },
      });

      const body = response.json();

      // issuer and authorization_endpoint use the frontend base URL (browser-facing)
      // regardless of the Host header
      expect(body.issuer).toBe("http://localhost:3000/");
      expect(body.authorization_endpoint).toBe(
        "http://localhost:3000/api/auth/oauth2/authorize",
      );
      // token endpoint uses the request Host (server-to-server)
      expect(body.token_endpoint).toBe(
        "http://host.docker.internal:9000/api/auth/oauth2/token",
      );
    });
  });
});
