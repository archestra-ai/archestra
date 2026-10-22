/**
 * An upstream tool's declared `outputSchema` survives tool sync and reaches
 * MCP gateway clients, so they can validate the `structuredContent` the
 * gateway relays. Runs a REAL streamable-HTTP upstream server, the real tool
 * sync, the real gateway route over a socket, and the SDK client, which
 * validates results against the advertised schema.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import mcpClient from "@/clients/mcp-client";
import {
  AgentToolModel,
  McpServerModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import { afterEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

const FORECAST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    temperatureC: { type: "number" },
  },
  required: ["city", "temperatureC"],
};

describe("MCP gateway - upstream tool outputSchema", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;
  let app: FastifyInstance | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await mcpClient.disconnectAll();
    await upstream?.close();
    await app?.close();
    client = undefined;
    upstream = undefined;
    app = undefined;
  });

  test("tools/list advertises the synced outputSchema and tools/call results validate against it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      url: upstream.url,
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    app = await gatewayApp();
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
    });

    const { tools } = await client.listTools();
    const forecast = tools.find((tool) => tool.name === install.toolName);
    expect(forecast?.outputSchema).toEqual(FORECAST_OUTPUT_SCHEMA);

    // The SDK client throws if structuredContent does not match the schema.
    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      city: "Lisbon",
      temperatureC: 21,
    });
  });

  test("a platform error result for a schema tool reaches the client as an error, not a schema violation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      url: upstream.url,
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    app = await gatewayApp();
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
    });
    await client.listTools();

    // The upstream goes away: the gateway answers with its own error result.
    await upstream.close();
    upstream = undefined;
    await mcpClient.disconnectAll();

    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(
      (result._meta as { archestraError?: unknown } | undefined)
        ?.archestraError,
    ).toBeDefined();
  });

  test("a tool without an outputSchema keeps the structured error envelope", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream({ outputSchema: false });
    const install = await installAndSync({
      url: upstream.url,
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    app = await gatewayApp();
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
    });

    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === install.toolName),
    ).not.toHaveProperty("outputSchema");

    await upstream.close();
    upstream = undefined;
    await mcpClient.disconnectAll();

    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toHaveProperty("archestraError");
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function installAndSync(params: {
  url: string;
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: "admin" },
  ) => Promise<unknown>;
  makeAgent: (overrides: {
    organizationId: string;
    agentType: "mcp_gateway";
    toolExposureMode: "full";
    accessAllTools: false;
  }) => Promise<{ id: string }>;
  makeInternalMcpCatalog: (overrides: {
    organizationId: string;
    name: string;
    serverType: "remote";
    serverUrl: string;
  }) => Promise<{ id: string; name: string }>;
  makeMcpServer: (overrides: {
    name: string;
    catalogId: string;
    ownerId: string;
    serverType: "remote";
  }) => Promise<{ id: string }>;
}) {
  const org = await params.makeOrganization();
  const user = await params.makeUser();
  await params.makeMember(user.id, org.id, { role: "admin" });
  const agent = await params.makeAgent({
    organizationId: org.id,
    agentType: "mcp_gateway",
    toolExposureMode: "full",
    accessAllTools: false,
  });
  const catalog = await params.makeInternalMcpCatalog({
    organizationId: org.id,
    name: "weather",
    serverType: "remote",
    serverUrl: params.url,
  });
  const { id: serverId } = await params.makeMcpServer({
    name: catalog.name,
    catalogId: catalog.id,
    ownerId: user.id,
    serverType: "remote",
  });

  const server = await McpServerModel.findById(serverId);
  if (!server) throw new Error("server not created");

  // The same sync that install and "reload tools" run.
  await reloadToolsForServer(server);
  const toolName = ToolModel.slugifyName(catalog.name, "get_forecast");
  const [tool] = (await ToolModel.findByCatalogIdWithMeta(catalog.id)).filter(
    (row) => row.name === toolName,
  );
  await AgentToolModel.create(agent.id, tool.id, { mcpServerId: serverId });

  const { value: token } = await UserTokenModel.create(user.id, org.id);
  return { agentId: agent.id, token, toolName };
}

async function gatewayApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(mcpGatewayRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

async function connectGatewayClient(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
}): Promise<Client> {
  const { port } = params.app.server.address() as AddressInfo;
  const client = new Client({ name: "output-schema-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/v1/mcp/${params.agentId}`),
      { requestInit: { headers: { Authorization: `Bearer ${params.token}` } } },
    ),
  );
  return client;
}

/** A stateless upstream with one tool that returns structured content. */
async function startUpstream(options: { outputSchema?: boolean } = {}) {
  const httpServer = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const mcp = new McpSdkServer(
        { name: "weather", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "get_forecast",
            description: "Forecast for a city",
            inputSchema: {
              type: "object" as const,
              properties: { city: { type: "string" } },
            },
            ...(options.outputSchema === false
              ? {}
              : { outputSchema: FORECAST_OUTPUT_SCHEMA }),
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        const forecast = {
          city: String(request.params.arguments?.city),
          temperatureC: 21,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(forecast) }],
          structuredContent: forecast,
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(
        req,
        res,
        body ? JSON.parse(body) : undefined,
      );
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  let closed = false;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      if (closed) return;
      closed = true;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
