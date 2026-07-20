/**
 * REAL end-to-end verification (no mocks) for the "don't register an MCP App
 * whose UI resource can't be read" fix.
 *
 * Spins up an actual streamable-HTTP MCP server and drives the REAL
 * `buildArchestraToolOutput` (the run_tool enrichment path) with the REAL
 * `mcpClient` against it — no mocked stand-in for the resource read.
 *
 *  - broken server (returns -32601 Method not found on resources/read, mimicking
 *    a third-party server like Atlassian Cloud that declares a `ui://` resource
 *    in tool _meta but never serves it) -> the tool result is plain text, NO
 *    `_meta.ui.resourceUri`, so chat registers no app (no pill, no auto-opened
 *    panel).
 *  - working server (serves the resource) -> `_meta.ui.resourceUri` is kept, so
 *    the gate discriminates on the real read rather than blanket-dropping.
 *
 * No `vi.mock` in this file on purpose: it runs against the real mcpClient.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildArchestraToolOutput } from "@/clients/chat-tool-builder";
import { expect, test } from "@/test";

const UI_RESOURCE_URI = "ui://brokenapp/app.html";

const RUN_TOOL_RESPONSE = {
  content: [{ type: "text" as const, text: "ran" }],
  structuredContent: { ok: true },
  _meta: { extra: 1 },
};

/** A real streamable-HTTP MCP server; `serveResource` toggles whether
 * resources/read succeeds or returns -32601 (like a server that advertises a
 * ui:// resource it doesn't actually serve). */
async function startMcpHttpServer(serveResource: boolean): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer = http.createServer(async (req, res) => {
    try {
      // Reject the client's optional standalone SSE stream (GET) so no
      // long-lived connection lingers in the shared test worker; the SDK client
      // treats 405 as "no server-initiated stream" and proceeds over POST.
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      // Stateless: fresh server + transport per request.
      const server = new McpSdkServer(
        { name: "test-app-server", version: "1.0.0" },
        { capabilities: { tools: {}, resources: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
      }));
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [],
      }));
      server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
        if (!serveResource) {
          throw new McpError(ErrorCode.MethodNotFound, "Method not found");
        }
        return {
          contents: [
            {
              uri: r.params.uri,
              mimeType: "text/html",
              text: "<html><body>real app</body></html>",
            },
          ],
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
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
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

test("REAL: drops the UI resource when the upstream returns -32601 on resources/read", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
  makeAgentTool,
}) => {
  const server = await startMcpHttpServer(/* serveResource */ false);
  try {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: server.url,
      requiresAuth: false,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const tool = await makeTool({
      name: "brokenapp__show",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });
    await makeAgentTool(agent.id, tool.id);

    const result = await buildArchestraToolOutput({
      response: RUN_TOOL_RESPONSE,
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "brokenapp__show", tool_args: {} },
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      tokenAuth: {
        tokenId: "integration-test-token",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
        organizationId: org.id,
        userId: user.id,
      },
    });

    // Dropped -> plain text, no MCP App registered.
    expect(result).toBe("ran");
  } finally {
    await server.close();
  }
});

test("REAL: keeps the UI resource when the upstream actually serves it", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
  makeAgentTool,
}) => {
  const server = await startMcpHttpServer(/* serveResource */ true);
  try {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: server.url,
      requiresAuth: false,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const tool = await makeTool({
      name: "brokenapp__show",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: UI_RESOURCE_URI } } },
    });
    await makeAgentTool(agent.id, tool.id);

    const result = await buildArchestraToolOutput({
      response: RUN_TOOL_RESPONSE,
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "brokenapp__show", tool_args: {} },
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      tokenAuth: {
        tokenId: "integration-test-token",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
        organizationId: org.id,
        userId: user.id,
      },
    });

    // Genuinely serveable -> the resource is still attached (control).
    expect(result).toMatchObject({
      content: "ran",
      _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
    });
  } finally {
    await server.close();
  }
});
