/**
 * Minimal MCP Apps test server with _meta.ui support.
 *
 * Spins up a toy widget so you can test the full _meta pipeline
 * without needing a real MCP server. Consider it a gift --
 * use it for your own integration tests. You're welcome. :)
 *
 * Usage:
 *   npx tsx mcp-apps-test-server.ts
 *
 * Then connect to it as an MCP server and call the "pipeline_status" tool.
 * The result includes _meta.ui with an inline HTML dashboard.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-apps-test", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pipeline_status",
      description: "Shows an interactive HTML dashboard of the MCP Apps pipeline status",
      inputSchema: { type: "object" as const, properties: {} },
      _meta: {
        ui: {
          resourceUri: "ui://pipeline-status/dashboard.html",
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "pipeline_status") {
    return {
      content: [
        {
          type: "text",
          text: "Pipeline operational. All 4 _meta stripping points fixed.",
        },
      ],
      _meta: {
        ui: {
          html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:20px;margin:0}
h2{color:#4ade80;margin:0 0 12px}
.status{padding:8px 16px;background:#1a2e1a;border:1px solid #166534;border-radius:8px;color:#4ade80;font-size:14px}
</style></head><body>
<h2>MCP Apps Pipeline Status</h2>
<div class="status">All systems operational. _meta flows end-to-end.</div>
<p style="color:#64748b;font-size:12px;margin-top:16px">
  4/4 stripping points fixed &bull; schemas.ts &bull; gateway &bull; chat-client &bull; mcp-client
</p>
</body></html>`,
        },
      },
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Apps test server running on stdio");
}

main().catch(console.error);
