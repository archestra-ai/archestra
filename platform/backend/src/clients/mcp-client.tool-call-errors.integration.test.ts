/**
 * What a failed tool call says, against a REAL streamable-HTTP MCP server, no
 * SDK mocks: the text reaches the model and the chat card, so it has to name
 * what actually happened.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

describe("what a failed tool call says", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;

  afterEach(async () => {
    await mcpClient.disconnectAll();
    await upstream?.close();
    upstream = undefined;
  });

  test("a server's own error with code -32000 keeps the server's words", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    // -32000 is the first code JSON-RPC leaves to servers, and also the code
    // the SDK raises when the connection closes. This one is the server's.
    const refused = await callTool({ ...install, tool: "refuse" });

    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "MCP error -32000: Out of quota" }],
    });
    // The connection is fine, so the next call reuses it.
    const next = await callTool({ ...install, tool: "ok" });
    expect(next).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "ok done" }],
    });
    expect(upstream.activity.initializations).toBe(1);
  });

  test("a rate-limited call reads as its status, not as the server's HTML page", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    const limited = await callTool({ ...install, tool: "limited" });

    expect(limited).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "The MCP server returned HTTP 429 (Too Many Requests). It is limiting requests. Try again in a minute.",
        },
      ],
    });
  });
});

describe("a question the server asks during a call", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;

  afterEach(async () => {
    await mcpClient.disconnectAll();
    await upstream?.close();
    upstream = undefined;
  });

  test("reaches the call's own handler when the call is a resource read", async ({
    makeUser,
  }) => {
    upstream = await startUpstream({ askOnResourceRead: true });
    const install = await installServer({ makeUser, url: upstream.url });
    const questions: string[] = [];

    // A tool the platform made from a resource is served by resources/read,
    // not tools/call. Its questions must be routed like a tool call's: with
    // no handler in place the question is cancelled and never shown.
    const result = await mcpClient.executeToolCallForOwner(
      { id: `call_${randomUUID()}`, name: "errors__read_notes", arguments: {} },
      agentOwner(install.agentId),
      {
        tokenId: "token",
        teamId: null,
        isOrganizationToken: false,
        userId: install.userId,
      },
      {
        conversationId: "conversation-1",
        elicitationHandler: async (request) => {
          questions.push(request.params.message);
          return { action: "accept", content: { confirm: true } };
        },
      },
    );

    expect(questions).toEqual(["Read the notes?"]);
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("notes after accept");
  });
});

// =============================================================================
// Helpers
// =============================================================================

const TOOLS = ["ok", "refuse", "limited"] as const;
const NOTES_URI = "notes://all";

const RATE_LIMIT_PAGE = `<!doctype html>
<html lang="en">
  <head><title>429</title></head>
  <body>${"<p>We had to rate limit you.</p>".repeat(200)}</body>
</html>`;

async function installServer(params: {
  makeUser: (overrides: { email: string }) => Promise<{ id: string }>;
  url: string;
}) {
  const user = await params.makeUser({ email: `${randomUUID()}@example.com` });
  const agent = await AgentModel.create({
    name: "Errors agent",
    scope: "org",
    teams: [],
  });
  const catalog = await InternalMcpCatalogModel.create({
    name: "errors",
    serverType: "remote",
    serverUrl: params.url,
  });
  const server = await McpServerModel.create({
    name: "errors",
    catalogId: catalog.id,
    serverType: "remote",
    ownerId: user.id,
  });
  for (const name of TOOLS) {
    const tool = await ToolModel.createToolIfNotExists({
      name: `errors__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });
    await AgentToolModel.create(agent.id, tool.id, { mcpServerId: server.id });
  }
  // A tool the platform synthesizes for a resource-only server.
  const resourceTool = await ToolModel.createToolIfNotExists({
    name: "errors__read_notes",
    description: "Read the notes resource",
    parameters: {},
    catalogId: catalog.id,
    meta: { _meta: { archestraResourceUri: NOTES_URI } },
  });
  await AgentToolModel.create(agent.id, resourceTool.id, {
    mcpServerId: server.id,
  });
  return { agentId: agent.id, userId: user.id };
}

function callTool(params: {
  agentId: string;
  userId: string;
  tool: (typeof TOOLS)[number];
}) {
  return mcpClient.executeToolCallForOwner(
    {
      id: `call_${randomUUID()}`,
      name: `errors__${params.tool}`,
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

/**
 * A stateful streamable-HTTP MCP server. `refuse` answers with a JSON-RPC
 * error of code -32000, and `limited` is cut off by an HTTP 429 with an HTML
 * page, the way a proxy in front of a server answers a rate limit.
 */
async function startUpstream(options: { askOnResourceRead?: boolean } = {}) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const activity = { initializations: 0 };

  const httpServer = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      if (
        parsed?.method === "tools/call" &&
        parsed.params?.name === "limited"
      ) {
        res
          .writeHead(429, { "content-type": "text/html; charset=utf-8" })
          .end(RATE_LIMIT_PAGE);
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        if (typeof sessionId === "string") {
          res.writeHead(404).end("Session not found");
          return;
        }
        activity.initializations += 1;
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // A question travels on the request's event stream.
          enableJsonResponse: !options.askOnResourceRead,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        const mcp = new McpSdkServer(
          { name: "errors", version: "1.0.0" },
          { capabilities: { tools: {}, resources: {} } },
        );
        mcp.setRequestHandler(ReadResourceRequestSchema, async (_, extra) => {
          const answer = await mcp.elicitInput(
            {
              message: "Read the notes?",
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
              },
            },
            { relatedRequestId: extra.requestId },
          );
          return {
            contents: [
              { uri: NOTES_URI, text: `notes after ${answer.action}` },
            ],
          };
        });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: TOOLS.map((name) => ({
            name,
            inputSchema: { type: "object" as const },
          })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (request.params.name === "refuse") {
            // The SDK sends an error's own `code` and `message` as the reply.
            throw Object.assign(new Error("Out of quota"), { code: -32000 });
          }
          return { content: [{ type: "text", text: "ok done" }] };
        });
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
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
