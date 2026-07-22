/**
 * MCP Gateway — external-IdP call-time credential-resolution guard.
 *
 * Full-stack regression test for the credential leak where a caller who
 * authenticates via an external IdP (JWKS/JWT) but has NOT set up their own
 * connection was routed through another user's personal install — running the
 * tool under that user's stored OAuth credentials (e.g. sending Slack messages
 * as someone else).
 *
 * Unlike the sibling `mcp-gateway.auth-at-call-time.test.ts` (which drives the
 * safe regular-user-token path), this exercises the leak at the level it
 * actually occurred: a real JWKS-authenticated HTTP request to the gateway
 * route, so the `isExternalIdp` flag is produced by the auth layer and threaded
 * into `resolveTargetMcpServerId` by production code — not hand-set in the test.
 *
 * Pre-fix, the resolver's IdP fallback picked `allServers[0]` (the other user's
 * personal install) and the call proceeded against it. Fixed, an unconnected
 * IdP caller fails closed into the actionable auth-required setup prompt.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import McpServerUserModel from "@/models/mcp-server-user";
import type { JwksValidationResult } from "@/services/jwks-validator";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const mockValidateJwt = vi.fn<() => Promise<JwksValidationResult | null>>();

vi.mock("@/services/jwks-validator", () => ({
  jwksValidator: {
    validateJwt: (...args: unknown[]) => mockValidateJwt(...(args as [])),
  },
}));

const { default: mcpGatewayRoutes } = await import("./mcp-gateway");

// A JWT-shaped bearer token that is NOT an Archestra token, so the gateway
// routes it through external-IdP JWKS validation instead of the token tables.
const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.jwt";
const CATALOG_NAME = "per-user-oauth-idp";
const FULL_TOOL_NAME = `${CATALOG_NAME}__send_message`;

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP Gateway - External IdP install guard", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
    mockValidateJwt.mockReset();
  });

  afterEach(async () => {
    await app.close();
  });

  test("an unconnected external-IdP caller never runs through another user's personal install", async ({
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

    // Another org member has connected their own account; the caller has not.
    const connectedUser = await makeUser();
    await makeMember(connectedUser.id, org.id);
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: "admin" });

    // Profile bound to an external identity provider (OIDC/JWKS).
    const idp = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "test-client",
        jwksEndpoint: "https://idp.example.com/.well-known/jwks.json",
      },
    });

    // Org-visible remote catalog + a tool it exposes.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: CATALOG_NAME,
      serverType: "remote",
      serverUrl: "https://remote.example.com/mcp",
      scope: "org",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: FULL_TOOL_NAME,
    });

    // The catalog's ONLY install is the connected user's personal connection —
    // the credential the pre-fix fallback would have borrowed.
    const otherInstall = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: connectedUser.id,
      scope: "personal",
      teamId: null,
    });
    await McpServerUserModel.assignUserToMcpServer(
      otherInstall.id,
      connectedUser.id,
    );

    // Gateway agent bound to the IdP, exposing the tool with dynamic
    // ("on behalf of the user") credential resolution.
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

    // The caller's JWT validates to the caller (who owns no install).
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

    // Fails closed into the auth-required setup prompt — NOT a call executed
    // through the connected user's install. (Pre-fix this returned a downstream
    // connection attempt against the other user's install instead.)
    expect(result).toHaveProperty("result");
    expect(result.result.isError).toBe(true);
    const textContent = result.result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("Authentication required for");
    expect(textContent.text).toContain("/mcp/registry?install=");
    expect(textContent.text).toContain(catalog.id);
  });
});
