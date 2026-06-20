import {
  getArchestraToolFullName,
  MCP_APPS_EXTENSION_ID,
  MCP_ENTERPRISE_AUTH_EXTENSION_ID,
  MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_EDIT_FILE_FULL_NAME,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_READ_APP_SHORT_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SAVE_RESULT_FULL_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel, UserTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./mcp-gateway";

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

async function initializeMcpSession(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
}) {
  const response = await params.app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}`,
    headers: makeMcpHeaders(params.token),
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

  expect(response.statusCode).toBe(200);
}

async function callMcpTool(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
  name: string;
  arguments: Record<string, unknown>;
}) {
  return params.app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}`,
    headers: makeMcpHeaders(params.token),
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: params.name,
        arguments: params.arguments,
      },
      id: 2,
    },
  });
}

function getPolicyBlockedText(response: {
  statusCode: number;
  json(): {
    result: {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
  };
}): string {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.result.isError).toBe(true);
  return body.result.content.map((item) => item.text ?? "").join("\n");
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
    expect(result.result.capabilities.extensions).toEqual({
      [MCP_APPS_EXTENSION_ID]: {},
      [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
      [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {},
    });
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

  test("ignores forwarded public origin in WWW-Authenticate when proxy trust is disabled", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.slug}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost:9000",
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
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
    expect(response.headers["www-authenticate"]).toContain(
      `resource_metadata="http://localhost:9000/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
    );
  });

  test("uses forwarded public origin in WWW-Authenticate when proxy trust is enabled", async ({
    makeAgent,
  }) => {
    const originalAllowlist = process.env.ARCHESTRA_API_BASE_URL;
    process.env.ARCHESTRA_API_BASE_URL = "https://gateway.example.com";
    const proxyApp = Fastify({
      trustProxy: true,
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
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
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="https://gateway.example.com/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
      if (originalAllowlist === undefined) {
        delete process.env.ARCHESTRA_API_BASE_URL;
      } else {
        process.env.ARCHESTRA_API_BASE_URL = originalAllowlist;
      }
    }
  });

  test("uses forwarded public origin when CIDR proxy trust matches the remote address", async ({
    makeAgent,
  }) => {
    const originalAllowlist = process.env.ARCHESTRA_API_BASE_URL;
    process.env.ARCHESTRA_API_BASE_URL = "https://gateway.example.com";
    const proxyApp = Fastify({
      trustProxy: "127.0.0.1/32",
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
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
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="https://gateway.example.com/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
      if (originalAllowlist === undefined) {
        delete process.env.ARCHESTRA_API_BASE_URL;
      } else {
        process.env.ARCHESTRA_API_BASE_URL = originalAllowlist;
      }
    }
  });

  test("ignores forwarded public origin when CIDR proxy trust does not match the remote address", async ({
    makeAgent,
  }) => {
    const proxyApp = Fastify({
      trustProxy: "10.0.0.0/8",
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
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
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="http://localhost:9000/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
    }
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

  test("handles whoami tool call successfully after initialize", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

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

    const callResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__whoami",
          arguments: {},
        },
        id: 2,
      },
    });

    expect(callResponse.statusCode).toBe(200);
    expect(callResponse.json().result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(agent.id),
        }),
      ]),
    );
  });

  test("direct tools/call applies target input-based invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked recipient",
      conditions: [{ key: "recipient", operator: "equal", value: "external" }],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: { recipient: "external" },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked recipient");
  });

  test("run_tool applies target input-based invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `run_policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked transfer",
      conditions: [{ key: "action", operator: "equal", value: "wire" }],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: { action: "wire" },
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked transfer");
  });

  test("direct tools/call blocks target tools that require approval", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `approval_direct_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: {},
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("run_tool blocks target tools that require approval", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `approval_run_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("direct tools/call applies untrusted-context invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `untrusted_direct_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      considerContextUntrusted: true,
    });
    await makeAgentTool(agent.id, tool.id);

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: {},
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("untrusted");
  });

  test("run_tool applies untrusted-context invocation policies to the target tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `untrusted_run_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      considerContextUntrusted: true,
    });
    await makeAgentTool(agent.id, tool.id);

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("untrusted");
  });

  test("run_tool applies target context-condition invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `team_policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [team.id],
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked for this team",
      conditions: [
        { key: "context.teamIds", operator: "contains", value: team.id },
      ],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked for this team");
  });

  test("keeps only meta and always-exposed tools in tools/list when toolExposureMode is search_and_run_only", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await seedAndAssignArchestraTools(agent.id);

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

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

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    const toolNames = response
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames.sort()).toEqual(
      [
        TOOL_LIST_SKILLS_FULL_NAME,
        TOOL_LOAD_SKILL_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
        TOOL_SEARCH_TOOLS_FULL_NAME,
      ].sort(),
    );
    expect(toolNames).not.toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
  });

  test("also keeps sandbox runtime and app tools top-level in tools/list when their features are enabled", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    const originalAppsEnabled = config.apps.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    (config.apps as { enabled: boolean }).enabled = true;

    try {
      const org = await makeOrganization();
      // sandbox tools are gated by sandbox:execute — authenticate as an admin so
      // RBAC does not strip them before exposure filtering runs.
      const adminUser = await makeUser();
      await makeMember(adminUser.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "mcp_gateway",
        toolExposureMode: "search_and_run_only",
      });
      await seedAndAssignArchestraTools(agent.id);

      const token = await UserTokenModel.create(adminUser.id, org.id);

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

      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 2,
        },
      });

      expect(response.statusCode).toBe(200);
      const toolNames = response
        .json()
        .result.tools.map((tool: { name: string }) => tool.name);
      expect(toolNames.sort()).toEqual(
        [
          TOOL_DOWNLOAD_FILE_FULL_NAME,
          TOOL_EDIT_FILE_FULL_NAME,
          TOOL_LIST_SKILLS_FULL_NAME,
          TOOL_LOAD_SKILL_FULL_NAME,
          TOOL_READ_FILE_FULL_NAME,
          TOOL_RUN_COMMAND_FULL_NAME,
          TOOL_RUN_TOOL_FULL_NAME,
          TOOL_SAVE_RESULT_FULL_NAME,
          TOOL_SEARCH_FILES_FULL_NAME,
          TOOL_SEARCH_TOOLS_FULL_NAME,
          TOOL_UPLOAD_FILE_FULL_NAME,
          getArchestraToolFullName(TOOL_SCAFFOLD_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_REFINE_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_EDIT_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_VALIDATE_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_PUBLISH_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_READ_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_RENDER_APP_SHORT_NAME),
          getArchestraToolFullName(TOOL_LIST_APPS_SHORT_NAME),
        ].sort(),
      );
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
      (config.apps as { enabled: boolean }).enabled = originalAppsEnabled;
    }
  });

  test("exposes implicit search_tools and run_tool without manual assignment when toolExposureMode is search_and_run_only", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

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

    const listResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json()
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(
      expect.arrayContaining([
        TOOL_SEARCH_TOOLS_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
      ]),
    );
  });

  test("GET endpoint resolves agent by slug", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Slug Test Gateway",
      organizationId: org.id,
      agentType: "mcp_gateway",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.slug}`,
      headers: makeMcpHeaders(token.value),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("name", `archestra-agent-${agent.id}`);
    expect(body).toHaveProperty("agentId", agent.id);
  });

  test("POST endpoint resolves agent by slug", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Slug POST Test",
      organizationId: org.id,
      agentType: "mcp_gateway",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.slug}`,
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
  });

  test("returns 401 for non-existent slug", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/non-existent-slug",
      headers: makeMcpHeaders("archestra_some_token"),
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
});
