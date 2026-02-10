import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import mcpClient from "@/clients/mcp-client";
import { TeamTokenModel, ToolModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
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

  test("tools/list includes stored _meta for MCP Apps UI", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
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

    const catalog = await makeInternalMcpCatalog({ name: "ui-catalog" });
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });

    const uiResourceUri = "ui://app/test";

    const tool = await ToolModel.createToolIfNotExists({
      name: "mcp_ui_tool",
      description: "Tool with MCP UI meta",
      parameters: { type: "object", properties: {} },
      catalogId: catalog.id,
      mcpServerId: mcpServer.id,
      meta: {
        ui: {
          resourceUri: uiResourceUri,
        },
      },
    });

    await makeAgentTool(agent.id, tool.id);

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

    expect(toolsResponse.statusCode).toBe(200);

    const body = toolsResponse.json() as {
      result?: { tools?: Array<Record<string, unknown>> };
    };

    expect(body.result?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "mcp_ui_tool",
          _meta: {
            ui: {
              resourceUri: uiResourceUri,
            },
          },
        }),
      ]),
    );
  });

  test("resources/list derives UI resources from tool meta", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
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

    const catalog = await makeInternalMcpCatalog({ name: "ui-catalog" });
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });

    const uiResourceUri = "ui://app/test";

    const tool = await ToolModel.createToolIfNotExists({
      name: "mcp_ui_tool",
      description: "Tool with MCP UI meta",
      parameters: { type: "object", properties: {} },
      catalogId: catalog.id,
      mcpServerId: mcpServer.id,
      meta: {
        ui: {
          resourceUri: uiResourceUri,
        },
      },
    });

    await makeAgentTool(agent.id, tool.id);

    const resourcesResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "resources/list",
        params: {},
        id: 1,
      },
    });

    expect(resourcesResponse.statusCode).toBe(200);

    const body = resourcesResponse.json() as {
      result?: { resources?: Array<Record<string, unknown>> };
    };

    expect(body.result?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: uiResourceUri,
        }),
      ]),
    );
  });

  test("resources/read delegates to underlying MCP server readResource", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
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

    const catalog = await makeInternalMcpCatalog({ name: "ui-catalog" });
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });

    const uiResourceUri = "ui://app/test";

    const tool = await ToolModel.createToolIfNotExists({
      name: "mcp_ui_tool",
      description: "Tool with MCP UI meta",
      parameters: { type: "object", properties: {} },
      catalogId: catalog.id,
      mcpServerId: mcpServer.id,
      meta: {
        ui: {
          resourceUri: uiResourceUri,
        },
      },
    });

    await makeAgentTool(agent.id, tool.id);

    const connectSpy = vi
      .spyOn(mcpClient, "connectAndReadResource")
      .mockResolvedValue({
        contents: [
          {
            uri: uiResourceUri,
            mimeType: "text/html;profile=mcp-app",
            text: "<html><body>test</body></html>",
          },
        ],
      } as unknown as Awaited<ReturnType<typeof mcpClient.connectAndReadResource>>);

    try {
      const readResponse = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: uiResourceUri },
          id: 1,
        },
      });

      expect(readResponse.statusCode).toBe(200);

      const body = readResponse.json() as {
        result?: { contents?: Array<Record<string, unknown>> };
      };

      expect(body.result?.contents).toEqual([
        {
          uri: uiResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: "<html><body>test</body></html>",
        },
      ]);

      expect(connectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: uiResourceUri,
          mcpServerId: mcpServer.id,
        }),
      );
    } finally {
      connectSpy.mockRestore();
    }
  });

  test("returns 401 with WWW-Authenticate header for missing authorization header", async ({
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

    // Verify WWW-Authenticate header is present with resource_metadata URL
    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain(
      `/.well-known/oauth-protected-resource/v1/mcp/${agent.id}`,
    );
  });

  test("returns 401 with WWW-Authenticate header for invalid token", async ({
    makeAgent,
  }) => {
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

    // Verify WWW-Authenticate header is present
    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });

  test("GET endpoint returns 401 with WWW-Authenticate header for missing authorization", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        accept: "application/json",
        // No authorization header
      },
    });

    expect(response.statusCode).toBe(401);

    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
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
