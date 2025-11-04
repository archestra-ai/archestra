import K8sPod from "./k8s-pod";

describe("K8sPod.slugifyMcpServerName", () => {
  test.each([
    // [input, expected output]
    // Basic conversions
    ["MY-SERVER", "my-server"],
    ["TestServer", "testserver"],

    // Spaces to hyphens
    ["My MCP Server", "my-mcp-server"],
    ["Server  Name", "server-name"],
    ["  LeadingSpaces", "leadingspaces"],

    // Special characters removed
    ["Test@123", "test123"],
    ["Server(v2)", "serverv2"],
    ["My-Server!", "my-server"],
    ["Test#Server$123", "testserver123"],

    // Valid characters preserved
    ["valid-name-123", "valid-name-123"],
    ["a-b-c-1-2-3", "a-b-c-1-2-3"],

    // Mixed case and special characters
    ["My MCP Server!", "my-mcp-server"],
    ["Test@123 Server", "test123-server"],
    ["Server (v2.0)", "server-v2.0"],

    // Edge cases
    ["", ""],
    ["!@#$%^&*()", ""],
    ["   ", ""],

    // Unicode characters
    ["Servér", "servr"],
    ["测试Server", "server"],

    // Consecutive spaces and special characters
    ["Server    Name", "server-name"],
    ["Test!!!Server", "testserver"],

    // Leading/trailing special characters
    ["@Server", "server"],
    ["Server@", "server"],
    ["!Server!", "server"],

    // Kubernetes DNS subdomain validation
    ["My Server @123!", "my-server-123"],

    // The reported bug case
    ["firecrawl - joey", "firecrawl-joey"],
  ])("converts '%s' to '%s'", (input, expected) => {
    const result = K8sPod.slugifyMcpServerName(input);
    expect(result).toBe(expected);

    // Verify all non-empty results are valid Kubernetes DNS subdomain names
    if (result) {
      // Must match pattern: lowercase alphanumeric, '-' or '.', start and end with alphanumeric
      expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      // Must be no longer than 253 characters
      expect(result.length).toBeLessThanOrEqual(253);
    }
  });
});
