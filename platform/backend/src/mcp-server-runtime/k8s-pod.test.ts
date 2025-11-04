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

describe("K8sPod.ensureStringIsRfc1123Compliant", () => {
  test.each([
    // [input, expected output]
    // Basic conversions
    ["MY-SERVER", "my-server"],
    ["TestServer", "testserver"],

    // Spaces to hyphens - the original bug case
    ["firecrawl - joey", "firecrawl-joey"],
    ["My MCP Server", "my-mcp-server"],
    ["Server  Name", "server-name"],

    // Special characters removed
    ["Test@123", "test123"],
    ["Server(v2)", "serverv2"],
    ["My-Server!", "my-server"],

    // Valid characters preserved
    ["valid-name-123", "valid-name-123"],
    ["a-b-c-1-2-3", "a-b-c-1-2-3"],

    // Unicode characters
    ["Servér", "servr"],
    ["测试Server", "server"],

    // Emojis
    ["Server 🔥 Fast", "server-fast"],

    // Leading/trailing special characters
    ["@Server", "server"],
    ["Server@", "server"],

    // Consecutive spaces and special characters
    ["Server    Name", "server-name"],
    ["Test!!!Server", "testserver"],

    // Dots are preserved (valid in Kubernetes DNS subdomain names)
    ["Server.v2.0", "server.v2.0"],

    // Multiple consecutive hyphens and dots are collapsed
    ["Server---Name", "server-name"],
    ["Server...Name", "server.name"],
  ])("converts '%s' to '%s'", (input, expected) => {
    const result = K8sPod.ensureStringIsRfc1123Compliant(input);
    expect(result).toBe(expected);

    // Verify all results are valid Kubernetes DNS subdomain names
    expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  });
});

describe("K8sPod.constructPodName", () => {
  test.each([
    // [server name, server id, expected pod name]
    // Basic conversions
    {
      name: "MY-SERVER",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-my-server",
    },
    {
      name: "TestServer",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-testserver",
    },

    // Spaces to hyphens - the original bug case
    {
      name: "firecrawl - joey",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-firecrawl-joey",
    },
    {
      name: "My MCP Server",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-my-mcp-server",
    },
    {
      name: "Server  Name",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-name",
    },

    // Special characters removed
    {
      name: "Test@123",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-test123",
    },
    {
      name: "Server(v2)",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-serverv2",
    },
    {
      name: "My-Server!",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-my-server",
    },

    // Valid characters preserved
    {
      name: "valid-name-123",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-valid-name-123",
    },
    {
      name: "a-b-c-1-2-3",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-a-b-c-1-2-3",
    },

    // Unicode characters
    {
      name: "Servér",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-servr",
    },
    {
      name: "测试Server",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server",
    },

    // Emojis
    {
      name: "Server 🔥 Fast",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-fast",
    },

    // Leading/trailing special characters
    {
      name: "@Server",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server",
    },
    {
      name: "Server@",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server",
    },

    // Consecutive spaces and special characters
    {
      name: "Server    Name",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-name",
    },
    {
      name: "Test!!!Server",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-testserver",
    },

    // Dots are preserved (valid in Kubernetes DNS subdomain names)
    {
      name: "Server.v2.0",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server.v2.0",
    },

    // Multiple consecutive hyphens and dots are collapsed
    {
      name: "Server---Name",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-name",
    },
    {
      name: "Server...Name",
      id: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server.name",
    },
  ])(
    "converts server name '$name' with id '$id' to pod name '$expected'",
    ({ name, id, expected }) => {
      // biome-ignore lint/suspicious/noExplicitAny: Minimal mock for testing
      const mockServer = { name, id } as any;
      const result = K8sPod.constructPodName(mockServer);
      expect(result).toBe(expected);

      // Verify all results are valid Kubernetes DNS subdomain names
      // Must match pattern: lowercase alphanumeric, '-' or '.', start and end with alphanumeric
      expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      // Must be no longer than 253 characters
      expect(result.length).toBeLessThanOrEqual(253);
      // Must start with 'mcp-'
      expect(result).toMatch(/^mcp-/);
    },
  );

  test("handles very long server names by truncating to 253 characters", () => {
    const longName = "a".repeat(300); // 300 character name
    const serverId = "123e4567-e89b-12d3-a456-426614174000";
    // biome-ignore lint/suspicious/noExplicitAny: Minimal mock for testing
    const mockServer = { name: longName, id: serverId } as any;

    const result = K8sPod.constructPodName(mockServer);

    expect(result.length).toBeLessThanOrEqual(253);
    expect(result).toMatch(/^mcp-a+$/); // Should be mcp- followed by many a's
    expect(result.length).toBe(253); // Should be exactly 253 chars (truncated)
  });

  test("produces consistent results for the same input", () => {
    const mockServer = {
      name: "firecrawl - joey",
      id: "123e4567-e89b-12d3-a456-426614174000",
      // biome-ignore lint/suspicious/noExplicitAny: Minimal mock for testing
    } as any;

    const result1 = K8sPod.constructPodName(mockServer);
    const result2 = K8sPod.constructPodName(mockServer);

    expect(result1).toBe(result2);
    expect(result1).toBe("mcp-firecrawl-joey");
  });
});

describe("K8sPod.sanitizeMetadataLabels", () => {
  test.each([
    {
      name: "sanitizes basic labels",
      input: {
        app: "mcp-server",
        "server-id": "123e4567-e89b-12d3-a456-426614174000",
        "server-name": "My Server Name",
      },
      expected: {
        app: "mcp-server",
        "server-id": "123e4567-e89b-12d3-a456-426614174000",
        "server-name": "my-server-name",
      },
    },
    {
      name: "handles the original bug case in labels",
      input: {
        app: "mcp-server",
        "mcp-server-name": "firecrawl - joey",
      },
      expected: {
        app: "mcp-server",
        "mcp-server-name": "firecrawl-joey",
      },
    },
    {
      name: "sanitizes both keys and values with special characters",
      input: {
        "my@key": "my@value",
        "weird key!": "weird value!",
      },
      expected: {
        mykey: "myvalue",
        "weird-key": "weird-value",
      },
    },
    {
      name: "preserves valid characters",
      input: {
        "valid-key": "valid-value",
        "another.key": "another.value",
        key123: "value123",
      },
      expected: {
        "valid-key": "valid-value",
        "another.key": "another.value",
        key123: "value123",
      },
    },
    {
      name: "handles empty object",
      input: {},
      expected: {},
    },
  ])("$name", ({ input, expected }) => {
    const result = K8sPod.sanitizeMetadataLabels(
      input as Record<string, string>,
    );
    expect(result).toEqual(expected);

    // Verify all keys and values are RFC 1123 compliant
    for (const [key, value] of Object.entries(result)) {
      expect(key).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      expect(value).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    }
  });
});
