import { createHash, randomUUID } from "node:crypto";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import mcpGatewayRoutes from "./index";

/**
 * Codex 0.159.2 (rmcp 3.2.0) treats a returned Mcp-Session-Id as a transport
 * session and DELETEs it on close. The gateway mints that id as signed
 * capability metadata, not a legacy SSE session. A missing DELETE route, or a
 * lookup in the legacy transport, is HTTP 404, which rmcp logs as
 * "fail to delete session". 405 is the only non-success rmcp treats as
 * "server does not support delete"; a bound session must be 2xx, and an
 * unbound id must not be.
 */

function mcpHeaders(
  token: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    ...(token && { authorization: `Bearer ${token}` }),
    ...extra,
  };
}

describe("MCP Gateway DELETE session termination", () => {
  const ctx = useRouteTestApp(mcpGatewayRoutes);

  test("OAuth initialize mints a session id that tools/list echoes and DELETE acknowledges", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const { app } = ctx;
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const oauthClient = await makeOAuthClient({ userId: user.id });
    const token = `test-oauth-token-${randomUUID()}`;
    await makeOAuthAccessToken(oauthClient.clientId, user.id, {
      token: createHash("sha256").update(token).digest("base64url"),
      referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${agent.id}`,
    });

    const initialize = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.slug}`,
      headers: mcpHeaders(token, { "content-type": "application/json" }),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: { elicitation: {} },
          clientInfo: { name: "codex", version: "0.159.2" },
        },
      },
    });
    expect(initialize.statusCode).toBe(200);
    const sessionId = initialize.headers["mcp-session-id"];
    expect(sessionId).toEqual(expect.any(String));
    expect(sessionId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const listed = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: mcpHeaders(token, {
        "content-type": "application/json",
        "mcp-session-id": String(sessionId),
        "mcp-protocol-version": "2025-06-18",
      }),
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain('"tools"');

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/${agent.slug}`,
      headers: mcpHeaders(token, {
        "mcp-session-id": String(sessionId),
        "mcp-protocol-version": "2025-06-18",
      }),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/${agent.id}`,
      headers: mcpHeaders(token, { "mcp-session-id": String(sessionId) }),
    });
    expect(again.statusCode).toBe(204);
  });

  test("refuses DELETE when the session is unknown or bound to another gateway or principal", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const { app } = ctx;
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const otherAgent = await makeAgent({ organizationId: org.id });
    const token = await makeServiceAccountToken({ organizationId: org.id });
    const otherToken = await makeServiceAccountToken({
      organizationId: org.id,
    });

    const initialize = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: mcpHeaders(token.value, { "content-type": "application/json" }),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { elicitation: { form: {} }, sampling: {} },
          clientInfo: { name: "codex", version: "0.159.2" },
        },
      },
    });
    const sessionId = String(initialize.headers["mcp-session-id"]);
    expect(sessionId).not.toBe("undefined");

    const unbound = [
      {
        name: "other principal",
        url: `/v1/mcp/${agent.id}`,
        token: otherToken.value,
        sessionId,
      },
      {
        name: "other gateway",
        url: `/v1/mcp/${otherAgent.id}`,
        token: token.value,
        sessionId,
      },
      {
        name: "unknown session",
        url: `/v1/mcp/${agent.id}`,
        token: token.value,
        sessionId: randomUUID(),
      },
      {
        name: "tampered signature",
        url: `/v1/mcp/${agent.id}`,
        token: token.value,
        sessionId: `${sessionId.slice(0, -1)}${sessionId.endsWith("a") ? "b" : "a"}`,
      },
    ];
    for (const scenario of unbound) {
      const response = await app.inject({
        method: "DELETE",
        url: scenario.url,
        headers: mcpHeaders(scenario.token, {
          "mcp-session-id": scenario.sessionId,
        }),
      });
      expect(response.statusCode, scenario.name).toBe(404);
      expect(response.json()).toMatchObject({
        error: { message: "Unknown session" },
      });
    }

    const missing = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/${agent.id}`,
      headers: mcpHeaders(token.value),
    });
    expect(missing.statusCode).toBe(400);

    const anonymous = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/${agent.id}`,
      headers: { "mcp-session-id": sessionId },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain(
      "resource_metadata=",
    );

    const owned = await app.inject({
      method: "DELETE",
      url: `/v1/mcp/${agent.id}`,
      headers: mcpHeaders(token.value, { "mcp-session-id": sessionId }),
    });
    expect(owned.statusCode).toBe(204);
  });
});
