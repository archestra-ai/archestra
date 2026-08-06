import {
  extractMcpExecutedAs,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

const executeToolCallForOwnerMock = vi.hoisted(() => vi.fn());

// The upstream call is the process boundary here: the point of these tests is
// what the gateway reports about the identity that served a call, not whether
// a real server answers.
vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    executeToolCallForOwner: executeToolCallForOwnerMock,
    resolveUiAppInstallIdForCaller: vi.fn().mockResolvedValue(null),
  },
}));

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP gateway executed-as identity", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    executeToolCallForOwnerMock.mockReset();
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function callTool(params: {
    agentId: string;
    token: string;
    name: string;
    arguments: Record<string, unknown>;
  }) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${params.agentId}`,
      headers: makeMcpHeaders(params.token),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: params.name, arguments: params.arguments },
        id: 2,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().result;
  }

  test("keeps the connection that served a dispatched tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `dispatch_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    // The dispatched call reached a real server through an org connection.
    executeToolCallForOwnerMock.mockResolvedValue({
      id: "call-1",
      name: tool.name,
      content: [{ type: "text", text: "upstream ok" }],
      isError: false,
      _meta: { archestraExecutedAs: { kind: "org" } },
    });

    const result = await callTool({
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: { tool_name: tool.name, tool_args: {} },
    });

    // run_tool is a platform tool, but the call it dispatched ran under the
    // organization's connection — that is the identity clients must see.
    expect(extractMcpExecutedAs(result)).toEqual({ kind: "org" });
  });

  test("attributes a tool the platform ran itself to the caller", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const result = await callTool({
      agentId: agent.id,
      token,
      name: TOOL_SEARCH_TOOLS_FULL_NAME,
      arguments: { query: "anything" },
    });

    // No server was contacted, so there is no connection to name — but the
    // call still ran on someone's behalf, and the card must say so.
    expect(extractMcpExecutedAs(result)).toMatchObject({ kind: "platform" });
    expect(executeToolCallForOwnerMock).not.toHaveBeenCalled();
  });
});
