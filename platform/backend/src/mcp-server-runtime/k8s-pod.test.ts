import type { LocalConfigSchema } from "@shared";
import type { z } from "zod";
import K8sPod from "./k8s-pod";

describe("K8sPod.createPodEnvFromConfig", () => {
  test.each([
    {
      testName: "returns empty array when no environment config is provided",
      input: undefined,
      expected: [],
    },
    {
      testName:
        "returns empty array when localConfig is provided but has no environment",
      input: {
        command: "node",
        arguments: ["server.js"],
      },
      expected: [],
    },
    {
      testName: "creates environment variables from localConfig.environment",
      input: {
        command: "node",
        arguments: ["server.js"],
        environment: {
          API_KEY: "secret123",
          PORT: "3000",
        },
      },
      expected: [
        { name: "API_KEY", value: "secret123" },
        { name: "PORT", value: "3000" },
      ],
    },
    {
      testName:
        "strips surrounding single quotes from environment variable values",
      input: {
        command: "node",
        environment: {
          API_KEY: "'my secret key'",
          MESSAGE: "'hello world'",
        },
      },
      expected: [
        { name: "API_KEY", value: "my secret key" },
        { name: "MESSAGE", value: "hello world" },
      ],
    },
    {
      testName:
        "strips surrounding double quotes from environment variable values",
      input: {
        command: "node",
        environment: {
          API_KEY: '"my secret key"',
          MESSAGE: '"hello world"',
        },
      },
      expected: [
        { name: "API_KEY", value: "my secret key" },
        { name: "MESSAGE", value: "hello world" },
      ],
    },
    {
      testName: "does not strip quotes if only at the beginning",
      input: {
        command: "node",
        environment: {
          VALUE1: "'starts with quote",
          VALUE2: '"starts with quote',
        },
      },
      expected: [
        { name: "VALUE1", value: "'starts with quote" },
        { name: "VALUE2", value: '"starts with quote' },
      ],
    },
    {
      testName: "does not strip quotes if only at the end",
      input: {
        command: "node",
        environment: {
          VALUE1: "ends with quote'",
          VALUE2: 'ends with quote"',
        },
      },
      expected: [
        { name: "VALUE1", value: "ends with quote'" },
        { name: "VALUE2", value: 'ends with quote"' },
      ],
    },
    {
      testName: "does not strip mismatched quotes",
      input: {
        command: "node",
        environment: {
          VALUE1: "'mismatched\"",
          VALUE2: "\"mismatched'",
        },
      },
      expected: [
        { name: "VALUE1", value: "'mismatched\"" },
        { name: "VALUE2", value: "\"mismatched'" },
      ],
    },
    {
      testName: "handles empty string values",
      input: {
        command: "node",
        environment: {
          EMPTY: "",
          EMPTY_SINGLE_QUOTES: "''",
          EMPTY_DOUBLE_QUOTES: '""',
        },
      },
      expected: [
        { name: "EMPTY", value: "" },
        { name: "EMPTY_SINGLE_QUOTES", value: "" },
        { name: "EMPTY_DOUBLE_QUOTES", value: "" },
      ],
    },
    {
      testName: "handles values with quotes in the middle",
      input: {
        command: "node",
        environment: {
          MESSAGE: "hello 'world' today",
          QUERY: 'SELECT * FROM users WHERE name="John"',
        },
      },
      expected: [
        { name: "MESSAGE", value: "hello 'world' today" },
        { name: "QUERY", value: 'SELECT * FROM users WHERE name="John"' },
      ],
    },
    {
      testName: "handles values that are just a single quote character",
      input: {
        command: "node",
        environment: {
          SINGLE_QUOTE: "'",
          DOUBLE_QUOTE: '"',
        },
      },
      expected: [
        { name: "SINGLE_QUOTE", value: "'" },
        { name: "DOUBLE_QUOTE", value: '"' },
      ],
    },
    {
      testName: "handles numeric values",
      input: {
        command: "node",
        environment: {
          PORT: 3000,
          TIMEOUT: 5000,
        },
      },
      expected: [
        { name: "PORT", value: "3000" },
        { name: "TIMEOUT", value: "5000" },
      ],
    },
    {
      testName: "handles boolean values",
      input: {
        command: "node",
        environment: {
          DEBUG: true,
          PRODUCTION: false,
        },
      },
      expected: [
        { name: "DEBUG", value: "true" },
        { name: "PRODUCTION", value: "false" },
      ],
    },
    {
      testName: "handles complex real-world scenario",
      input: {
        command: "node",
        arguments: ["server.js"],
        environment: {
          API_KEY: "'sk-1234567890abcdef'",
          DATABASE_URL: '"postgresql://user:pass@localhost:5432/db"',
          NODE_ENV: "production",
          PORT: 8080,
          ENABLE_LOGGING: true,
          MESSAGE: "'Hello, World!'",
          PATH: "/usr/local/bin:/usr/bin",
        },
      },
      expected: [
        { name: "API_KEY", value: "sk-1234567890abcdef" },
        {
          name: "DATABASE_URL",
          value: "postgresql://user:pass@localhost:5432/db",
        },
        { name: "NODE_ENV", value: "production" },
        { name: "PORT", value: "8080" },
        { name: "ENABLE_LOGGING", value: "true" },
        { name: "MESSAGE", value: "Hello, World!" },
        { name: "PATH", value: "/usr/local/bin:/usr/bin" },
      ],
    },
  ])("$testName", ({ input, expected }) => {
    const result = K8sPod.createPodEnvFromConfig(
      input as z.infer<typeof LocalConfigSchema> | undefined,
    );
    expect(result).toEqual(expected);
  });
});

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
