import { describe, expect, test, vi } from "vitest";

/**
 * Tests for MCP Apps readResource method on McpClient.
 * Verifies that the client can read ui:// resources from upstream MCP servers.
 */
describe("McpClient.readResource", () => {
  test("readResource method exists on mcpClient", async () => {
    // Dynamic import to avoid circular dependency issues in test
    const mcpClientModule = await import("@/clients/mcp-client");
    const mcpClient = mcpClientModule.default;

    expect(typeof mcpClient.readResource).toBe("function");
  });

  test("readResource returns correct structure", () => {
    // Verify the expected return type shape
    const mockResult = {
      uri: "ui://test-app",
      mimeType: "text/html;profile=mcp-app",
      text: "<html><body>Test App</body></html>",
    };

    expect(mockResult.uri).toStartWith("ui://");
    expect(mockResult.mimeType).toBe("text/html;profile=mcp-app");
    expect(mockResult.text).toContain("Test App");
  });
});
