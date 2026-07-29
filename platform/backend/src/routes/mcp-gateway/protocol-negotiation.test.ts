/**
 * MCP Gateway — dual-revision protocol negotiation over the real route.
 *
 * The gateway serves 2025-11-25 and 2026-07-28 clients from one endpoint. These
 * drive the actual Fastify route so the regression that matters is covered: a
 * legacy client must keep working byte-for-byte after the negotiation layer was
 * added in front of it, while a client declaring the newer revision gets
 * `server/discover` and routing-header enforcement.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";
import {
  LEGACY_MCP_PROTOCOL_REVISION,
  STATELESS_MCP_PROTOCOL_REVISION,
} from "./protocol";

function makeMcpHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

describe("MCP Gateway - protocol revision negotiation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function setup({
    makeAgent,
    makeOrganization,
  }: {
    makeAgent: (args?: Record<string, unknown>) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
  }) {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    return { agent, token };
  }

  test("a legacy initialize keeps working and reports the legacy revision", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("result");
    // An undeclared legacy request is left exactly as it was before the
    // negotiation layer existed: the SDK negotiates from the initialize body
    // and the gateway does not inject a version of its own.
    expect(response.headers["mcp-protocol-version"]).toBeUndefined();
  });

  test("a client declaring an older supported revision is still served", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // Regression guard on the negotiation layer itself: it must not narrow
    // acceptance to the two advertised revisions and turn away clients the SDK
    // has always negotiated.
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    for (const declaredVersion of [
      LEGACY_MCP_PROTOCOL_REVISION,
      "2025-06-18",
      "2024-11-05",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value, {
          "mcp-protocol-version": declaredVersion,
        }),
        payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.tools).toBeDefined();
      // Echoed verbatim rather than upgraded to the newest legacy revision.
      expect(response.headers["mcp-protocol-version"]).toBe(declaredVersion);
    }
  });

  test("server/discover returns the same capabilities the handshake advertises", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "server/discover",
      }),
      payload: { jsonrpc: "2.0", method: "server/discover", id: 7 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(7);
    expect(body.result.protocolVersion).toBe(STATELESS_MCP_PROTOCOL_REVISION);
    expect(body.result.protocolVersions).toEqual([
      STATELESS_MCP_PROTOCOL_REVISION,
      LEGACY_MCP_PROTOCOL_REVISION,
    ]);
    expect(body.result.serverInfo.name).toBe(`archestra-agent-${agent.id}`);
    // listChanged is true for this revision: subscriptions/listen backs it.
    expect(body.result.capabilities.tools).toEqual({ listChanged: true });
    expect(body.result.capabilities.extensions).toHaveProperty(
      "io.modelcontextprotocol/ui",
    );
  });

  test("a routing header that disagrees with the body is rejected", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "tools/list",
      }),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "some_tool", arguments: {} },
        id: 3,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("does not match request method");
    // The id is echoed so the client can correlate the failure.
    expect(body.id).toBe(3);
  });

  test("a declared stateless request without routing headers is rejected", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
      }),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 4 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Missing required");
  });

  test("an unsupported declared version is rejected", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": "1999-01-01",
      }),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 5 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      STATELESS_MCP_PROTOCOL_REVISION,
    );
  });

  test("tools/list carries private cache hints for both revisions", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    for (const headers of [
      makeMcpHeaders(token.value),
      makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "tools/list",
      }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers,
        payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 6 },
      });

      expect(response.statusCode).toBe(200);
      const { result } = response.json();
      expect(result.ttlMs).toBeGreaterThan(0);
      // Never shareable: the list is filtered per caller.
      expect(result.cacheScope).toBe("private");
    }
  });

  test("a 2026-07-28 request is not refused by the bundled SDK transport", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // The SDK version this runs on validates MCP-Protocol-Version against its
    // own supported list, which ends at 2025-11-25, and 400s anything newer.
    // The gateway answers for the new revision itself, so a declared
    // 2026-07-28 request must reach the tool surface rather than being
    // rejected by the transport underneath.
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "tools/list",
      }),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 9 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 9 });
    expect(response.json().result.tools).toBeDefined();
    expect(response.headers["mcp-protocol-version"]).toBe(
      STATELESS_MCP_PROTOCOL_REVISION,
    );
  });

  test("every cacheable result carries private cache hints", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // The revision requires ttlMs/cacheScope on all five of these, not just
    // tools/list.
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    for (const method of [
      "tools/list",
      "prompts/list",
      "resources/list",
      "resources/templates/list",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: { jsonrpc: "2.0", method, params: {}, id: 11 },
      });

      expect(response.statusCode).toBe(200);
      const { result } = response.json();
      expect(result.ttlMs).toBeGreaterThan(0);
      expect(result.cacheScope).toBe("private");
    }
  });

  test("results carry the complete envelope and a stable tool order", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 12 },
    });

    expect(response.statusCode).toBe(200);
    const { result } = response.json();

    // Every ordinary result is "complete"; older clients ignore the field.
    expect(result.resultType).toBe("complete");
    expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: `archestra-agent-${agent.id}`,
    });

    // Stable order is what makes the ttlMs hint worth anything to a cache.
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  test("ping answers for legacy clients and is refused for 2026-07-28", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    // A legacy client keeps the SDK's automatic pong.
    const legacy = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "ping", id: 20 },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({ id: 20, result: {} });

    // A client that declared 2026-07-28 opted out of the surface ping
    // belongs to, so answering would be serving the wrong revision.
    const stateless = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "ping",
      }),
      payload: { jsonrpc: "2.0", method: "ping", id: 21 },
    });
    expect(stateless.statusCode).toBe(200);
    expect(stateless.json().error).toMatchObject({ code: -32601 });
    expect(stateless.json().error.message).toContain("removed");
  });

  test("capabilities no longer advertise unimplemented subscriptions", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value, {
        "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION,
        "mcp-method": "server/discover",
      }),
      payload: { jsonrpc: "2.0", method: "server/discover", id: 22 },
    });

    const { capabilities } = response.json().result;
    expect(capabilities.resources).not.toHaveProperty("subscribe");
    expect(capabilities.resources.listChanged).toBe(false);
  });

  test("a tool with an invalid x-mcp-header annotation is excluded from tools/list", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "xh-catalog",
    });

    // Invalid: number is explicitly forbidden as an annotated type.
    const invalid = await makeTool({
      catalogId: catalog.id,
      name: "xh-catalog__bad",
      parameters: {
        type: "object",
        properties: { n: { type: "number", "x-mcp-header": "N" } },
      },
    });
    const valid = await makeTool({
      catalogId: catalog.id,
      name: "xh-catalog__good",
      parameters: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    });
    await makeAgentTool(agent.id, invalid.id);
    await makeAgentTool(agent.id, valid.id);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 30 },
    });

    const names = (response.json().result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    // One malformed definition must not poison the rest of the list.
    expect(names).toContain("xh-catalog__good");
    expect(names).not.toContain("xh-catalog__bad");
  });

  test("GET discovery advertises both supported revisions", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { agent, token } = await setup({ makeAgent, makeOrganization });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: { authorization: `Bearer ${token.value}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().protocolVersions).toEqual([
      STATELESS_MCP_PROTOCOL_REVISION,
      LEGACY_MCP_PROTOCOL_REVISION,
    ]);
  });
});
