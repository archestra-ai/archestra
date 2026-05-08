// biome-ignore-all lint/suspicious/noConsole: test MCP server logs startup details
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

const PORT = Number(process.env.PORT || 3456);
const MCP_PATH = process.env.MCP_PATH || "/mcp";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post(MCP_PATH, async (req, res) => {
  const authorizationHeader = req.headers.authorization ?? "";
  const token = authorizationHeader.replace(/^Bearer\s+/i, "");
  const server = new McpServer({
    name: "entra-obo-debug-mcp",
    version: "1.0.0",
  });

  server.tool(
    "debug-auth-token",
    "Return the downstream bearer token metadata received by this MCP server.",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              authorizationHeaderPresent: Boolean(authorizationHeader),
              authorizationHeaderScheme: authorizationHeader
                ? authorizationHeader.split(/\s+/)[0]
                : null,
              token: {
                audience: getClaim(token, "aud"),
                scopes: getScopes(token),
                tenantId: getClaim(token, "tid"),
                issuer: getClaim(token, "iss"),
                username:
                  getClaim(token, "preferred_username") ??
                  getClaim(token, "upn") ??
                  getClaim(token, "email"),
                subject: getClaim(token, "sub"),
                appId: getClaim(token, "appid") ?? getClaim(token, "azp"),
              },
              claims: decodeJwtPayload(token),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

app.get(MCP_PATH, (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

app.delete(MCP_PATH, (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `entra-obo-debug-mcp listening at http://localhost:${PORT}${MCP_PATH}`,
  );
});

function getScopes(token: string) {
  const scp = getClaim(token, "scp");
  if (typeof scp === "string") return scp.split(/\s+/).filter(Boolean);

  const roles = getClaim(token, "roles");
  return Array.isArray(roles) ? roles : [];
}

function getClaim(token: string, claim: string) {
  return decodeJwtPayload(token)?.[claim] ?? null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
