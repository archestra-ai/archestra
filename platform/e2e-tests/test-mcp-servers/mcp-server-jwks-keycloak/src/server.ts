import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { requireAuth } from "./auth.js";
import { registerTools } from "./tools.js";

const app = express();
app.use(express.json());

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:3456";
const KEYCLOAK_ISSUER_URL =
  process.env.KEYCLOAK_ISSUER_URL || "http://localhost:8080/realms/mcp-demo";

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: MCP_SERVER_URL,
    authorization_servers: [KEYCLOAK_ISSUER_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", requireAuth, async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Missing authenticated user context" });
    return;
  }

  const server = new McpServer({
    name: "jwks-demo-server",
    version: "1.1.0",
  });

  registerTools(server, req.auth);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

const PORT = 3456;
app.listen(PORT, () => {});
