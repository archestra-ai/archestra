/**
 * Wire-level coverage for the inspector's outbound credential.
 *
 * Unlike the rest of the inspect-route tests, nothing between the route and the
 * socket is mocked here: a real HTTP server stands in for both the IdP token
 * endpoint and the upstream MCP server, and the real transport makes the
 * request. That is the only way to assert what the upstream actually receives —
 * the regression this guards against was a missing header, which every
 * mock-level assertion happily reported as success.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAUTH_TOKEN_TYPE } from "@archestra/shared";
import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth/utils", () => ({
  hasPermission: vi.fn(),
  userHasPermission: vi.fn(),
}));

describe("mcp server inspect route — outbound enterprise credential", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let server: Server;
  let baseUrl: string;
  let upstreamRequestHeaders: Array<Record<string, string | undefined>>;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    upstreamRequestHeaders = [];
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id);
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
    vi.mocked(userHasPermission).mockResolvedValue(true);

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        // The IdP's token endpoint, exchanging the caller's assertion.
        if (req.url?.startsWith("/token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "exchanged-upstream-token",
              issued_token_type: OAUTH_TOKEN_TYPE.AccessToken,
              token_type: "Bearer",
              expires_in: 300,
            }),
          );
          return;
        }

        // The upstream MCP server.
        upstreamRequestHeaders.push({
          ...(req.headers as Record<string, string | undefined>),
        });
        const message = JSON.parse(Buffer.concat(chunks).toString() || "{}");

        if (message.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "mcp-session-id": "inspect-session",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion:
                  message.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "upstream", version: "1.0.0" },
              },
            }),
          );
          return;
        }

        if (message.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: "get_application",
                    description: "Reads one application",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            }),
          );
          return;
        }

        res.writeHead(202).end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });
    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.mocked(hasPermission).mockReset();
    vi.mocked(userHasPermission).mockReset();
  });

  test("every upstream request carries the configured custom header", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: `${baseUrl}/realms/archestra`,
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint: `${baseUrl}/token`,
        tokenEndpointAuthentication: "client_secret_post",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
          tokenEndpoint: `${baseUrl}/token`,
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Custom Header Upstream",
      serverType: "remote",
      serverUrl: `${baseUrl}/mcp`,
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "header",
        headerName: "x-provider-api-token",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tools: [expect.objectContaining({ name: "get_application" })],
    });

    // The `initialize` handshake is where this regressed — it reached the
    // upstream with no credential at all — so assert on every request the
    // inspection made, not just the one carrying tools/list.
    expect(upstreamRequestHeaders.length).toBeGreaterThan(0);
    for (const headers of upstreamRequestHeaders) {
      expect(headers["x-provider-api-token"]).toBe("exchanged-upstream-token");
      expect(headers.authorization).toBeUndefined();
    }
  });
});
