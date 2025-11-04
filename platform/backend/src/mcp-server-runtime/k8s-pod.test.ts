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

    // Accented characters
    ["Café José", "caf-jos"],
    ["José Ramón", "jos-ramn"],

    // Emojis
    ["Server 🔥 Fast", "server-fast"],
    ["Hello 😊 World", "hello-world"],

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
