import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

describe("POST /api/internal_mcp_catalog validation", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);

  test.for([
    [
      "a non-http server URL",
      { serverType: "remote", serverUrl: "javascript:alert(1)" },
    ],
    [
      "an out-of-range HTTP port",
      {
        serverType: "local",
        localConfig: { command: "node", httpPort: 99999 },
      },
    ],
    [
      "an HTTP path without a leading slash",
      {
        serverType: "local",
        localConfig: { command: "node", httpPath: "mcp" },
      },
    ],
    [
      "an environment variable key with a space",
      {
        serverType: "local",
        localConfig: {
          command: "node",
          environment: [
            { key: "MY VAR", type: "plain_text", promptOnInstallation: false },
          ],
        },
      },
    ],
    [
      "a name longer than 255 characters",
      {
        name: "n".repeat(256),
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      },
    ],
  ] as const)("rejects %s", async ([, payload], { makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: { name: "invalid-catalog-item", ...payload },
    });

    expect(response.statusCode).toBe(400);
  });

  test("accepts an http(s) remote server", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "valid-remote-server",
        serverType: "remote",
        serverUrl: "http://localhost:8080/mcp",
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
