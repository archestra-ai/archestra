/**
 * A tool call that fails on the caller's own expired connection is recovered
 * through a URL-mode elicitation when the client declares one: the client is
 * asked to open the re-authentication page, and once a new credential lands
 * the gateway re-runs the call. A client without URL mode keeps the error
 * text with the link.
 *
 * Runs a REAL streamable-HTTP upstream that rejects revoked tokens, the real
 * gateway route over a socket, and the SDK client (2025-11-25) or raw
 * requests (2026-07-28).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  getArchestraToolFullName,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type ClientCapabilities,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  type ElicitResult,
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
import { secretManager } from "@/secrets-manager";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import { afterEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import mcpGatewayRoutes from "./index";
import { PendingInboundRequests } from "./pending-inbound-requests";
import { cachedPendingRequests } from "./pending-inbound-shared";
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_META_KEY,
} from "./protocol";

// The answer to a mid-call prompt is routed back through the shared cache.
setupTestCacheManager();

describe("MCP gateway - re-authentication through URL elicitation", () => {
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

  test("a client with URL mode is sent to the re-authentication page, then gets the tool's real result", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      upstream,
      fixtures: {
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
      },
    });
    upstream.revoke(INITIAL_TOKEN);
    app = await gatewayApp();

    const prompts: Array<Record<string, unknown>> = [];
    const completed: string[] = [];
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
      capabilities: { elicitation: { form: {}, url: {} } },
      onElicit: async (params) => {
        prompts.push(params);
        // The person signs in again on the page the link opens.
        await reauthenticate({ serverId: install.serverId });
        return { action: "accept" };
      },
      onElicitationComplete: (elicitationId) => completed.push(elicitationId),
    });

    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "Lisbon: 21C" }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ mode: "url" });
    expect(prompts[0].url).toContain(
      `/mcp/registry?reauth=${install.catalogId}&server=${install.serverId}`,
    );
    // The client's "waiting for the server" prompt is told it is done.
    expect(completed).toEqual([prompts[0].elicitationId]);
  });

  test("a call dispatched through run_tool recovers the same way", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      upstream,
      // The default gateway: clients see search_tools and run_tool only.
      toolExposureMode: "search_and_run_only",
      fixtures: {
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
      },
    });
    upstream.revoke(INITIAL_TOKEN);
    app = await gatewayApp();

    const prompts: Array<Record<string, unknown>> = [];
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
      capabilities: { elicitation: { form: {}, url: {} } },
      onElicit: async (params) => {
        prompts.push(params);
        await reauthenticate({ serverId: install.serverId });
        return { action: "accept" };
      },
    });

    const result = await client.callTool({
      name: getArchestraToolFullName(TOOL_RUN_TOOL_SHORT_NAME),
      arguments: { tool_name: install.toolName, tool_args: { city: "Lisbon" } },
    });

    expect(prompts).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(errorText(result)).toContain("Lisbon: 21C");
  });

  test("a client without URL mode keeps the error text with the re-authentication link", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      upstream,
      fixtures: {
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
      },
    });
    upstream.revoke(INITIAL_TOKEN);
    app = await gatewayApp();

    const prompts: unknown[] = [];
    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
      // What Cursor declares: forms only.
      capabilities: { elicitation: { form: {} } },
      onElicit: async (params) => {
        prompts.push(params);
        return { action: "cancel" };
      },
    });

    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });

    expect(prompts).toEqual([]);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      `/mcp/registry?reauth=${install.catalogId}&server=${install.serverId}`,
    );
  });

  test("declining the prompt returns the error text with the link", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      upstream,
      fixtures: {
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
      },
    });
    upstream.revoke(INITIAL_TOKEN);
    app = await gatewayApp();

    client = await connectGatewayClient({
      app,
      agentId: install.agentId,
      token: install.token,
      capabilities: { elicitation: { form: {}, url: {} } },
      onElicit: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: install.toolName,
      arguments: { city: "Lisbon" },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(`reauth=${install.catalogId}`);
  });

  test("a client on the stateless revision gets the link as an input request, and its retry returns the real result", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    upstream = await startUpstream();
    const install = await installAndSync({
      upstream,
      fixtures: {
        makeOrganization,
        makeUser,
        makeMember,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
      },
    });
    upstream.revoke(INITIAL_TOKEN);
    app = await gatewayApp();
    const { port } = app.server.address() as AddressInfo;
    const call = async (extraParams: Record<string, unknown>) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/mcp/${install.agentId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${install.token}`,
            [MCP_METHOD_HEADER]: "tools/call",
            [MCP_NAME_HEADER]: install.toolName,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: install.toolName,
              arguments: { city: "Lisbon" },
              _meta: {
                [MCP_PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                [MCP_CLIENT_CAPABILITIES_META_KEY]: {
                  elicitation: { form: {}, url: {} },
                },
              },
              ...extraParams,
            },
          }),
        },
      );
      return firstResult(response);
    };

    const first = await call({});
    expect(first).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        gateway_reauthentication: {
          method: "elicitation/create",
          params: { mode: "url" },
        },
      },
    });
    const prompt = (
      first.inputRequests as Record<string, { params: { url: string } }>
    ).gateway_reauthentication;
    expect(prompt.params.url).toContain(
      `/mcp/registry?reauth=${install.catalogId}&server=${install.serverId}`,
    );

    // The person accepts; the retry waits for the new credential to land.
    const retry = call({
      inputResponses: { gateway_reauthentication: { action: "accept" } },
      requestState: first.requestState,
    });
    await reauthenticate({ serverId: install.serverId });

    expect(await retry).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "Lisbon: 21C" }],
    });
  });
});

// =============================================================================
// Helpers
// =============================================================================

const INITIAL_TOKEN = "initial-token";
const FRESH_TOKEN = "fresh-token";

/** What the re-authentication route does: store a new secret on the install. */
async function reauthenticate(params: { serverId: string }) {
  const secret = await secretManager().createSecret(
    { access_token: FRESH_TOKEN },
    "weather-token",
  );
  await McpServerModel.update(params.serverId, { secretId: secret.id });
}

async function installAndSync(params: {
  upstream: { url: string };
  toolExposureMode?: "full" | "search_and_run_only";
  fixtures: {
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
      toolExposureMode: "full" | "search_and_run_only";
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
      scope: "personal";
      serverType: "remote";
      secretId: string;
    }) => Promise<{ id: string }>;
  };
}) {
  const { fixtures } = params;
  const org = await fixtures.makeOrganization();
  const user = await fixtures.makeUser();
  await fixtures.makeMember(user.id, org.id, { role: "admin" });
  const agent = await fixtures.makeAgent({
    organizationId: org.id,
    agentType: "mcp_gateway",
    toolExposureMode: params.toolExposureMode ?? "full",
    accessAllTools: false,
  });
  const catalog = await fixtures.makeInternalMcpCatalog({
    organizationId: org.id,
    name: "weather",
    serverType: "remote",
    serverUrl: params.upstream.url,
  });
  const secret = await secretManager().createSecret(
    { access_token: INITIAL_TOKEN },
    "weather-token",
  );
  const { id: serverId } = await fixtures.makeMcpServer({
    name: catalog.name,
    catalogId: catalog.id,
    ownerId: user.id,
    scope: "personal",
    serverType: "remote",
    secretId: secret.id,
  });

  const server = await McpServerModel.findById(serverId);
  if (!server) throw new Error("server not created");
  await reloadToolsForServer(server);
  const toolName = ToolModel.slugifyName(catalog.name, "get_forecast");
  const [tool] = (
    await ToolModel.findByCatalogIdWithMeta(catalog.id, { kind: "caller" })
  ).filter((row) => row.name === toolName);
  await AgentToolModel.create(agent.id, tool.id, { mcpServerId: serverId });

  const { value: token } = await UserTokenModel.create(user.id, org.id);
  return {
    agentId: agent.id,
    catalogId: catalog.id,
    serverId,
    token,
    toolName,
  };
}

async function gatewayApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(mcpGatewayRoutes, {
    pendingRequests: new PendingInboundRequests({
      shared: cachedPendingRequests,
    }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

async function connectGatewayClient(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
  capabilities: ClientCapabilities;
  onElicit: (params: Record<string, unknown>) => Promise<ElicitResult>;
  onElicitationComplete?: (elicitationId: string) => void;
}): Promise<Client> {
  const { port } = params.app.server.address() as AddressInfo;
  const client = new Client(
    { name: "reauth-elicitation-test", version: "1.0.0" },
    { capabilities: params.capabilities },
  );
  client.setRequestHandler(ElicitRequestSchema, (request) =>
    params.onElicit(request.params as Record<string, unknown>),
  );
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    (notification) =>
      params.onElicitationComplete?.(notification.params.elicitationId),
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/v1/mcp/${params.agentId}`),
      { requestInit: { headers: { Authorization: `Bearer ${params.token}` } } },
    ),
  );
  return client;
}

function errorText(result: unknown): string {
  return (
    ((result as { content?: unknown }).content ?? []) as Array<{
      type: string;
      text?: string;
    }>
  )
    .map((part) => part.text ?? "")
    .join("\n");
}

/** The result of a JSON or SSE response to one request. */
async function firstResult(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)))
        .find((message) => "result" in message || "error" in message)
    : JSON.parse(text);
  if (!payload?.result) {
    throw new Error(`expected a result, got ${text}`);
  }
  return payload.result;
}

/** A stateless upstream that accepts a token until it is revoked. */
async function startUpstream() {
  const revoked = new Set<string>();
  const httpServer = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!token || revoked.has(token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
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
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [
          { type: "text", text: `${request.params.arguments?.city}: 21C` },
        ],
      }));
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
    revoke: (token: string) => revoked.add(token),
    close: async () => {
      if (closed) return;
      closed = true;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
