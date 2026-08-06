/**
 * MCP Gateway — external-IdP callers vs. stored static header credentials.
 *
 * Full-stack regression test for the credential clobber where a caller who
 * authenticates via an external IdP (JWKS/JWT) called a tool on a remote
 * connection whose stored credential is a custom userConfig field mapped to
 * the `Authorization` header (how hand-configured remote servers commonly
 * store their key). Those installs don't populate the canonical
 * `access_token`/`raw_access_token` secret fields, so the transport's
 * IdP-JWT fallback misread them as "no stored authorization" and overwrote
 * the working header with the caller's JWT — the upstream rejected every
 * gateway call while the same connection kept working for
 * session-authenticated callers, and the resulting error blamed the (valid)
 * stored credential.
 *
 * Like the sibling `external-idp-install-guard.test.ts`, this drives a real
 * JWKS-authenticated HTTP request through the gateway route so the
 * `isExternalIdp` flag is produced by the auth layer, and it fakes the remote
 * MCP server at the network boundary (MSW) so the assertion is on the actual
 * Authorization header that reached the wire.
 */

import { MCP_EXECUTED_AS_META_KEY } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { secretManager } from "@/secrets-manager";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

const mockValidateJwt = vi.fn<() => Promise<JwksValidationResult | null>>();

vi.mock("@/services/jwks-validator", () => ({
  jwksValidator: {
    validateJwt: (...args: unknown[]) => mockValidateJwt(...(args as [])),
  },
}));

const { default: mcpGatewayRoutes } = await import("./index");

// A JWT-shaped bearer token that is NOT an Archestra token, so the gateway
// routes it through external-IdP JWKS validation instead of the token tables.
const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.jwt";
const CATALOG_NAME = "static-header-remote";
const FULL_TOOL_NAME = `${CATALOG_NAME}__query`;
const UPSTREAM_URL = "https://static-header-upstream.example.com/mcp";
const STORED_HEADER_VALUE = "Bearer stored-static-header-key";

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP Gateway - external IdP with stored static-header credential", () => {
  const mswServer = useMswServer();
  let app: FastifyInstance;
  // Authorization header of every request the fake upstream MCP server saw.
  let upstreamAuthHeaders: Array<string | null>;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
    mockValidateJwt.mockReset();
    upstreamAuthHeaders = [];

    // A minimal stateless streamable-http MCP server at the network boundary:
    // enough of the protocol for connect + tools/list + tools/call, recording
    // the Authorization header on every request.
    mswServer.use(
      http.post(UPSTREAM_URL, async ({ request }) => {
        upstreamAuthHeaders.push(request.headers.get("authorization"));
        const body = (await request.json()) as {
          id?: number | string;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (body.method === "initialize") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "static-header-upstream", version: "1.0.0" },
            },
          });
        }
        if (body.id === undefined) {
          // Notifications (e.g. notifications/initialized) expect 202.
          return new HttpResponse(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "query", inputSchema: { type: "object" } }],
            },
          });
        }
        if (body.method === "tools/call") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "upstream says hi" }],
              isError: false,
            },
          });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      }),
      // The SDK probes for a standalone SSE stream; 405 means "not offered".
      http.get(UPSTREAM_URL, () => new HttpResponse(null, { status: 405 })),
      http.delete(UPSTREAM_URL, () => new HttpResponse(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    // The gateway caches upstream connections; drop them so the next test's
    // MSW handlers see a fresh connect instead of a reused session.
    await mcpClient.disconnectAll();
    await app.close();
  });

  test("sends the stored custom-field Authorization header upstream, not the caller's JWT", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeAgentTool,
    makeIdentityProvider,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: "admin" });

    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://idp.example.com/.well-known/jwks.json",
      },
    });

    // Remote catalog entry whose only credential is a custom userConfig field
    // mapped to the Authorization header — no canonical access_token field.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: CATALOG_NAME,
      serverType: "remote",
      serverUrl: UPSTREAM_URL,
      scope: "org",
      userConfig: {
        api_token: {
          type: "string",
          title: "Authorization",
          description: 'Sent as Authorization with a "Bearer " prefix',
          required: true,
          sensitive: true,
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      },
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: FULL_TOOL_NAME,
    });

    // Organization-wide connection holding the working static credential.
    const secret = await secretManager().createSecret(
      { api_token: "stored-static-header-key" },
      "static-header-org-secret",
    );
    await makeMcpServer({
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
      secretId: secret.id,
    });

    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      identityProviderId: idp.id,
      toolExposureMode: "full",
      accessAllTools: false,
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });

    mockValidateJwt.mockResolvedValue({
      sub: caller.email,
      email: caller.email,
      name: "Caller",
      rawClaims: { sub: caller.email },
    });

    // Stateless mode requires an initialize before a tools/call.
    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(FAKE_JWT),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(FAKE_JWT),
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: FULL_TOOL_NAME, arguments: {} },
      },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();

    // The call succeeded through the org connection's stored credential —
    // no "expired or invalid authentication" error blaming a valid key.
    expect(result).toHaveProperty("result");
    expect(result.result.isError).toBeFalsy();
    const textContent = result.result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent?.text).toBe("upstream says hi");

    // Every request that reached the upstream carried the stored credential;
    // the caller's IdP JWT never replaced it.
    expect(upstreamAuthHeaders.length).toBeGreaterThan(0);
    for (const header of upstreamAuthHeaders) {
      expect(header).toBe(STORED_HEADER_VALUE);
    }

    // And the executed-as identity names the org connection — not an IdP
    // passthrough of the caller's own token.
    expect(result.result._meta?.[MCP_EXECUTED_AS_META_KEY]).toEqual({
      kind: "org",
    });
  });
});
