import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import oauthRoutes, { discoverOAuthEndpoints, discoverScopes } from "./oauth";
import { OAUTH_CALLBACK_PATH } from "./route-paths";

setupTestCacheManager();

describe("OAuth metadata validation", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        user,
        organizationId,
        authMethod: "session",
        sessionInfo: {
          id: "oauth-metadata-test-session",
          createdAt: new Date(),
        },
      });
    });
    await app.register(oauthRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test.for([
    "issuer",
    "resource",
    "valid",
  ] as const)("validates %s metadata before registration and authorization", async (variant, {
    makeInternalMcpCatalog,
  }) => {
    const requests: string[] = [];
    let origin: string;
    const server = createServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("Content-Type", "application/json");
      const send = (body: unknown) => response.end(JSON.stringify(body));
      if (request.url === "/.well-known/oauth-protected-resource/mcp") {
        send({
          resource:
            variant === "resource"
              ? "https://other.example.com/mcp"
              : `${origin}/mcp`,
          authorization_servers: [origin],
        });
      } else if (request.url === "/.well-known/oauth-authorization-server") {
        send({
          issuer: variant === "issuer" ? "https://other.example.com" : origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      } else if (request.url === "/register") {
        send({
          client_id: "metadata-test-client",
          token_endpoint_auth_method: "none",
        });
      } else if (request.url?.startsWith("/authorize?")) {
        const url = new URL(request.url, origin);
        const redirect = new URL(
          url.searchParams.get("redirect_uri") as string,
        );
        redirect.searchParams.set("code", "metadata-test-code");
        redirect.searchParams.set(
          "state",
          url.searchParams.get("state") as string,
        );
        redirect.searchParams.set("iss", origin);
        response.writeHead(302, { Location: redirect.toString() });
        response.end();
      } else if (request.url === "/token") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const params = new URLSearchParams(body);
        expect(params.get("code")).toBe("metadata-test-code");
        expect(params.get("code_verifier")).toBeTruthy();
        send({
          access_token: "metadata-test-access-token",
          refresh_token: "metadata-test-refresh-token",
          expires_in: 3600,
        });
      } else {
        response.writeHead(404);
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "OAuth metadata test",
        serverType: "remote",
        serverUrl: `${origin}/mcp`,
        oauthConfig: {
          name: "OAuth metadata test",
          server_url: `${origin}/mcp`,
          grant_type: "authorization_code",
          client_id: "",
          redirect_uris: ["http://localhost:3000/oauth-callback"],
          scopes: [],
          default_scopes: [],
          additional_scopes: [],
          supports_resource_metadata: true,
        },
      });
      const initiation = await app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        payload: { catalogId: catalog.id },
      });
      expect(requests).toContain(
        "GET /.well-known/oauth-protected-resource/mcp",
      );
      if (variant !== "valid") {
        expect(initiation.statusCode, initiation.body).toBe(502);
        expect(initiation.json().error.message).toMatch(/issuer|resource/i);
        expect(requests).not.toContain("POST /register");
        expect(requests).not.toContain("POST /token");
        expect(initiation.json()).not.toHaveProperty("authorizationUrl");
        return;
      }
      expect(initiation.statusCode, initiation.body).toBe(200);
      const authorization = await fetch(initiation.json().authorizationUrl, {
        redirect: "manual",
      });
      expect(authorization.status).toBe(302);
      const callbackUrl = new URL(
        authorization.headers.get("location") as string,
      );
      const callback = await app.inject({
        method: "POST",
        url: OAUTH_CALLBACK_PATH,
        payload: Object.fromEntries(callbackUrl.searchParams),
      });
      expect(callback.statusCode, callback.body).toBe(200);
      expect(callback.json()).toMatchObject({
        success: true,
        accessToken: "metadata-test-access-token",
      });
      expect(requests).toContain("POST /register");
      expect(requests).toContain("POST /token");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("OAuth metadata identities", () => {
  const serverUrl = "https://mcp.example.com/mcp";
  const issuer = "https://auth.example.com/tenant";

  test.for([
    undefined,
    "",
    "https://other.example.com/tenant",
    "https://auth.example.com/other",
    `${issuer}/`,
    "https://AUTH.example.com/tenant",
  ])("rejects an invalid advertised issuer %s without using explicit endpoint fallback", async (metadataIssuer) => {
    await expect(
      discoverOAuthEndpoints(
        {
          server_url: serverUrl,
          supports_resource_metadata: true,
          authorization_endpoint: "https://configured.example.com/authorize",
          token_endpoint: "https://configured.example.com/token",
        },
        {
          fetchFn: async (input) => {
            if (String(input).includes("oauth-protected-resource")) {
              return Response.json({
                resource: serverUrl,
                authorization_servers: [issuer],
              });
            }
            return Response.json({
              issuer: metadataIssuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
            });
          },
        },
      ),
    ).rejects.toThrow("issuer does not match");
  });

  test.for([
    undefined,
    "",
    "https://other.example.com/mcp",
    "https://mcp.example.com/other",
    `${serverUrl}/`,
  ])("rejects an invalid resource %s from an explicit metadata URL", async (resource) => {
    const requests: string[] = [];
    await expect(
      discoverOAuthEndpoints(
        {
          server_url: serverUrl,
          supports_resource_metadata: true,
          resource_metadata_url:
            "https://metadata.example.com/protected-resource",
        },
        {
          fetchFn: async (input) => {
            requests.push(String(input));
            return Response.json({ resource, authorization_servers: [issuer] });
          },
        },
      ),
    ).rejects.toThrow("resource does not match");
    expect(requests).toEqual([
      "https://metadata.example.com/protected-resource",
    ]);
  });

  test("uses the validated resource's authorization server for scope discovery", async () => {
    const requests: string[] = [];
    const scopes = await discoverScopes(serverUrl, true, [], {
      fetchFn: async (input) => {
        requests.push(String(input));
        if (String(input).includes("oauth-protected-resource")) {
          return Response.json({
            resource: serverUrl,
            authorization_servers: [issuer],
          });
        }
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          scopes_supported: ["tools:read"],
        });
      },
    });
    expect(scopes).toEqual(["tools:read"]);
    expect(requests).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
    ]);
  });
});
