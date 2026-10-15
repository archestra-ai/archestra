/**
 * An installed MCP server that announces `notifications/tools/list_changed`
 * over an open connection gets its catalog's tool snapshot re-synced. Runs
 * against a REAL streamable-HTTP MCP server, no SDK mocks.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

describe("tools/list_changed from an installed MCP server", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;

  afterEach(async () => {
    await mcpClient.disconnectAll();
    await upstream?.close();
    upstream = undefined;
  });

  test("a burst of notifications re-syncs the catalog's tools exactly once", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    // Opens the connection the notifications arrive on.
    const result = await callEcho(install);
    expect(result.isError).toBe(false);
    await waitUntil(() => upstream?.activity.notificationStreams === 1);

    upstream.toolNames.push("added_upstream");
    const listCallsBefore = upstream.activity.listToolsCalls;
    for (let i = 0; i < 3; i += 1) {
      await upstream.announceToolListChanged();
    }

    const expectedNames = ["echo", "added_upstream"]
      .map((name) => ToolModel.slugifyName(install.catalogName, name))
      .sort();
    await waitUntil(
      async () =>
        JSON.stringify(await catalogToolNames(install.catalogId)) ===
        JSON.stringify(expectedNames),
    );
    // Past the coalescing window: nothing else is queued behind that sync.
    await sleep(1_500);
    expect(upstream.activity.listToolsCalls - listCallsBefore).toBe(1);
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function installServer(params: {
  makeUser: (overrides: { email: string }) => Promise<{ id: string }>;
  url: string;
}) {
  const user = await params.makeUser({ email: `${randomUUID()}@example.com` });
  const agent = await AgentModel.create({
    name: "List-changed agent",
    scope: "org",
    teams: [],
  });
  const catalogName = "listchanged";
  const catalog = await InternalMcpCatalogModel.create({
    name: catalogName,
    serverType: "remote",
    serverUrl: params.url,
  });
  const server = await McpServerModel.create({
    name: catalogName,
    catalogId: catalog.id,
    serverType: "remote",
    ownerId: user.id,
  });
  const tool = await ToolModel.createToolIfNotExists({
    name: ToolModel.slugifyName(catalogName, "echo"),
    description: "echo",
    parameters: {},
    catalogId: catalog.id,
  });
  await AgentToolModel.create(agent.id, tool.id, { mcpServerId: server.id });
  return {
    agentId: agent.id,
    userId: user.id,
    catalogId: catalog.id,
    catalogName,
  };
}

function callEcho(params: {
  agentId: string;
  userId: string;
  catalogName: string;
}) {
  return mcpClient.executeToolCallForOwner(
    {
      id: `call_${randomUUID()}`,
      name: ToolModel.slugifyName(params.catalogName, "echo"),
      arguments: {},
    },
    agentOwner(params.agentId),
    {
      tokenId: "token",
      teamId: null,
      isOrganizationToken: false,
      userId: params.userId,
    },
  );
}

async function catalogToolNames(catalogId: string) {
  const rows = await db
    .select({ name: schema.toolsTable.name })
    .from(schema.toolsTable)
    .where(eq(schema.toolsTable.catalogId, catalogId));
  return rows.map((row) => row.name).sort();
}

/**
 * A stateful streamable-HTTP MCP server whose advertised tool list the test
 * mutates, and which announces the change on every open session.
 */
async function startUpstream() {
  const toolNames = ["echo"];
  const sessions = new Map<string, McpSdkServer>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const activity = { listToolsCalls: 0, notificationStreams: 0 };

  const httpServer = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      if (req.method === "GET") activity.notificationStreams += 1;

      let transport =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        const mcp = new McpSdkServer(
          { name: "listchanged", version: "1.0.0" },
          { capabilities: { tools: { listChanged: true } } },
        );
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, created);
            sessions.set(id, mcp);
          },
        });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => {
          activity.listToolsCalls += 1;
          return {
            tools: toolNames.map((name) => ({
              name,
              inputSchema: { type: "object" as const },
            })),
          };
        });
        mcp.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: "text", text: "echo" }],
        }));
        await mcp.connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    activity,
    toolNames,
    announceToolListChanged: async () => {
      for (const mcp of sessions.values()) {
        await mcp.sendToolListChanged();
      }
    },
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error("Condition not met");
    await sleep(20);
  }
}
