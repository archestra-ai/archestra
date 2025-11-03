import K8sPod from "./k8s-pod";

describe("K8sPod.slugifyMcpServerName", () => {
  test("converts uppercase to lowercase", () => {
    expect(K8sPod.slugifyMcpServerName("MY-SERVER")).toBe("my-server");
    expect(K8sPod.slugifyMcpServerName("TestServer")).toBe("testserver");
  });

  test("replaces spaces with hyphens", () => {
    expect(K8sPod.slugifyMcpServerName("My MCP Server")).toBe("my-mcp-server");
    expect(K8sPod.slugifyMcpServerName("Server  Name")).toBe("server--name");
    expect(K8sPod.slugifyMcpServerName("  LeadingSpaces")).toBe(
      "--leadingspaces",
    );
  });

  test("removes special characters", () => {
    expect(K8sPod.slugifyMcpServerName("Test@123")).toBe("test123");
    expect(K8sPod.slugifyMcpServerName("Server(v2)")).toBe("serverv2");
    expect(K8sPod.slugifyMcpServerName("My-Server!")).toBe("my-server");
    expect(K8sPod.slugifyMcpServerName("Test#Server$123")).toBe(
      "testserver123",
    );
  });

  test("preserves valid characters (lowercase letters, digits, hyphens)", () => {
    expect(K8sPod.slugifyMcpServerName("valid-name-123")).toBe(
      "valid-name-123",
    );
    expect(K8sPod.slugifyMcpServerName("a-b-c-1-2-3")).toBe("a-b-c-1-2-3");
  });

  test("handles mixed case and special characters", () => {
    expect(K8sPod.slugifyMcpServerName("My MCP Server!")).toBe("my-mcp-server");
    expect(K8sPod.slugifyMcpServerName("Test@123 Server")).toBe(
      "test123-server",
    );
    expect(K8sPod.slugifyMcpServerName("Server (v2.0)")).toBe("server-v20");
  });

  test("handles empty string", () => {
    expect(K8sPod.slugifyMcpServerName("")).toBe("");
  });

  test("handles string with only special characters", () => {
    expect(K8sPod.slugifyMcpServerName("!@#$%^&*()")).toBe("");
    expect(K8sPod.slugifyMcpServerName("   ")).toBe("---");
  });

  test("handles unicode characters", () => {
    expect(K8sPod.slugifyMcpServerName("Servér")).toBe("servr");
    expect(K8sPod.slugifyMcpServerName("测试Server")).toBe("server");
  });

  test("handles consecutive spaces and special characters", () => {
    expect(K8sPod.slugifyMcpServerName("Server    Name")).toBe(
      "server----name",
    );
    expect(K8sPod.slugifyMcpServerName("Test!!!Server")).toBe("testserver");
  });

  test("handles strings starting or ending with special characters", () => {
    expect(K8sPod.slugifyMcpServerName("@Server")).toBe("server");
    expect(K8sPod.slugifyMcpServerName("Server@")).toBe("server");
    expect(K8sPod.slugifyMcpServerName("!Server!")).toBe("server");
  });

  test("produces valid Kubernetes DNS subdomain names", () => {
    // Kubernetes DNS names must be lowercase alphanumeric with hyphens
    const result = K8sPod.slugifyMcpServerName("My Server @123!");
    expect(result).toBe("my-server-123");
    // Verify it matches valid DNS name pattern
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});
