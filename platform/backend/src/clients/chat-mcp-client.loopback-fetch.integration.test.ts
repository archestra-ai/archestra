/**
 * REAL end-to-end verification (no mocks) that the chat MCP client no longer
 * drives the recurring GET SSE poll against the loopback gateway.
 *
 * Background: the MCP SDK's `StreamableHTTPClientTransport` opens an optional
 * standalone GET SSE stream after `initialized`. The real gateway answers that
 * GET with finite discovery JSON (`200`), which the SDK reads as an empty SSE
 * stream and reconnects roughly once per second — each GET running DB-backed
 * profile/auth work. The transport built by `createLoopbackGatewayTransport`
 * injects a fetch that short-circuits the SDK's GET to a `405`, so the SDK
 * stops polling and no GET ever reaches the network.
 *
 * This drives the REAL production transport factory against a real stateless
 * streamable-HTTP MCP server (like the gateway) that would happily answer GET
 * with `200` JSON, and asserts the server observes zero GET requests while a
 * POST-based `tools/list` still succeeds AND still carries the Bearer token
 * (proving the JSON-RPC POST path passes through the custom fetch untouched).
 *
 * No `vi.mock` on purpose: it runs against a real client, transport, and server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";
import { createLoopbackGatewayTransport } from "@/clients/chat-mcp-client";

/** A real stateless streamable-HTTP MCP server that mirrors the gateway: POST
 * carries JSON-RPC, and GET is answered with a `200` JSON body (the exact shape
 * that makes the SDK loop). Records GET arrivals and the last POST's bearer. */
async function startGatewayLikeServer(): Promise<{
  url: string;
  getRequestCount: () => number;
  lastPostAuthorization: () => string | undefined;
  close: () => Promise<void>;
}> {
  let getRequests = 0;
  let lastPostAuth: string | undefined;
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        getRequests += 1;
        // Mimic the discovery route: finite JSON, not SSE. A client that does
        // NOT short-circuit its GET would receive this and reconnect forever.
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      lastPostAuth = req.headers.authorization;
      const server = new McpSdkServer(
        { name: "gateway-like", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      let body = "";
      for await (const chunk of req) body += chunk;
      await server.connect(transport);
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
    getRequestCount: () => getRequests,
    lastPostAuthorization: () => lastPostAuth,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

test("REAL: the loopback transport stops the SDK GET SSE poll while the POST path still carries the bearer", async () => {
  const server = await startGatewayLikeServer();
  const client = new Client({ name: "loopback-fetch-test", version: "1.0.0" });
  try {
    // Drive the exact production transport construction.
    const transport = createLoopbackGatewayTransport(server.url, "test-token");

    await client.connect(transport);
    // POST path must still work end-to-end through the custom fetch...
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    // ...and still carry the Bearer token the transport was built with.
    expect(server.lastPostAuthorization()).toBe("Bearer test-token");

    // Give any floating GET SSE reconnect attempt time to fire against the
    // network. The SDK's first standalone GET is issued immediately after the
    // `initialized` 202 (no backoff), so without the fix it would already have
    // arrived; with the fix it is answered 405 in-process and never reaches us.
    await new Promise((r) => setTimeout(r, 300));
    expect(server.getRequestCount()).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});
