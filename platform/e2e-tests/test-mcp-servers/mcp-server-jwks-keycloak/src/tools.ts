import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthContext } from "./auth.js";

export function registerTools(server: McpServer, auth: AuthContext): void {
  server.tool(
    "whoami",
    "Show the current authenticated user and token-derived identity details",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              user: {
                sub: auth.sub,
                email: auth.email,
                name: auth.name,
                preferredUsername: auth.preferredUsername,
                demoTokenValue: auth.demoTokenValue,
                roles: auth.roles,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "debug-auth-token",
    "Print the incoming Authorization header, raw bearer token, and decoded token details",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              authorizationHeader: auth.authorizationHeader,
              bearerToken: auth.rawToken,
              tokenClaims: {
                iss: auth.issuer,
                aud: auth.audience,
                sub: auth.sub,
                email: auth.email,
                name: auth.name,
                preferredUsername: auth.preferredUsername,
                demoTokenValue: auth.demoTokenValue,
                roles: auth.roles,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "get-server-info",
    "Get MCP server information and your authentication details",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              server: "MCP JWKS Demo Server",
              version: "1.1.0",
              user: {
                sub: auth.sub,
                email: auth.email,
                name: auth.name,
                preferredUsername: auth.preferredUsername,
                demoTokenValue: auth.demoTokenValue,
                roles: auth.roles,
              },
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "query-database",
    "Query the database (requires db-reader role)",
    { query: z.string().describe("SQL query to execute") },
    async ({ query }) => {
      if (!auth.roles.includes("db-reader")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Access denied: you need the 'db-reader' role to use this tool.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                results: [
                  { id: 1, name: "Widget A", price: 29.99 },
                  { id: 2, name: "Widget B", price: 49.99 },
                  { id: 3, name: "Widget C", price: 99.99 },
                ],
                rowCount: 3,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
