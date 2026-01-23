import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { mcpGatewayRoutes } from "./mcp-gateway";

/**
 * Helper to create MCP gateway request headers
 * The MCP SDK requires Accept header with both application/json and text/event-stream
 */
function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP Gateway (stateless mode)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Create a test Fastify app
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("handles initialize request successfully (stateless)", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    // Create an org token for authentication
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    // Send initialize request
    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
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

    // In stateless mode, no session ID should be returned
    // (or if returned, it's ephemeral and not stored)
    const result = initResponse.json();
    expect(result).toHaveProperty("result");
  });

  test("handles tools/list request successfully (stateless)", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    // Send tools/list request directly without prior initialize
    // In stateless mode, each request creates a fresh server
    const toolsResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      },
    });

    // The MCP SDK may require initialize first, which would return an error
    // But the gateway itself should handle the request without session errors
    expect([200, 400]).toContain(toolsResponse.statusCode);

    if (toolsResponse.statusCode === 400) {
      const body = toolsResponse.json();
      // If error, it should be "Server not initialized", not a session error
      expect(body.error?.message).toContain("Server not initialized");
    }
  });

  test("returns 401 for missing authorization header", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // No authorization header
      },
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

    expect(response.statusCode).toBe(401);
  });

  test("returns 401 for invalid token", async ({ makeAgent }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders("archestra_invalid_token_12345"),
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

    expect(response.statusCode).toBe(401);
  });

  test("GET endpoint returns server discovery info", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("name", `archestra-agent-${agent.id}`);
    expect(body).toHaveProperty("transport", "http");
    expect(body).toHaveProperty("capabilities");
    expect(body.capabilities).toHaveProperty("tools", true);
  });
});
