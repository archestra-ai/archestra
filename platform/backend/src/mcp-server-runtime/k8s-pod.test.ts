import type * as k8s from "@kubernetes/client-node";
import type { Attach, Log } from "@kubernetes/client-node";
import type { LocalConfigSchema } from "@shared";
import { vi } from "vitest";
import type { z } from "zod";
import { describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import K8sPod from "./k8s-pod";

// Helper function to create a K8sPod instance with mocked dependencies
function createK8sPodInstance(
  environmentValues?: Record<string, string | number | boolean>,
  userConfigValues?: Record<string, string>,
): K8sPod {
  // Create mock McpServer
  const mockMcpServer = {
    id: "test-server-id",
    name: "test-server",
    catalogId: "test-catalog-id",
    secretId: null,
    ownerId: null,
    reinstallRequired: false,
    localInstallationStatus: "idle",
    localInstallationError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as McpServer;

  // Create mock K8s API objects
  const mockK8sApi = {} as k8s.CoreV1Api;
  const mockK8sAttach = {} as Attach;
  const mockK8sLog = {} as Log;

  // Convert environment values to strings as the constructor expects
  const stringEnvironmentValues = environmentValues
    ? Object.fromEntries(
        Object.entries(environmentValues).map(([key, value]) => [
          key,
          String(value),
        ]),
      )
    : undefined;

  return new K8sPod(
    mockMcpServer,
    mockK8sApi,
    mockK8sAttach,
    mockK8sLog,
    "default",
    null, // catalogItem
    userConfigValues,
    stringEnvironmentValues,
  );
}

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
    // Filter out undefined values from environment to match the strict Record type
    const environmentValues = input?.environment
      ? (Object.fromEntries(
          Object.entries(input.environment).filter(
            ([, value]) => value !== undefined,
          ),
        ) as Record<string, string | number | boolean>)
      : undefined;

    const instance = createK8sPodInstance(environmentValues);
    const result = instance.createPodEnvFromConfig();
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
  ])("converts server name '$name' with id '$id' to pod name '$expected'", ({
    name,
    id,
    expected,
  }) => {
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
  });

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
    {
      name: "truncates label values to 63 characters",
      input: {
        "long-value": "a".repeat(100),
      },
      expected: {
        "long-value": "a".repeat(63),
      },
    },
    {
      name: "removes trailing non-alphanumeric after truncation",
      input: {
        // 62 'a's followed by a hyphen = 63 chars. Truncation keeps the hyphen, regex should remove it.
        "trailing-hyphen": `${"a".repeat(62)}-`,
      },
      expected: {
        "trailing-hyphen": "a".repeat(62),
      },
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

describe("K8sPod.generatePodSpec", () => {
  // Helper function to create a mock K8sPod instance
  function createMockK8sPod(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): K8sPod {
    const mockK8sApi = {} as k8s.CoreV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const namespace = "default";

    return new K8sPod(
      mcpServer,
      mockK8sApi,
      mockK8sAttach,
      mockK8sLog,
      namespace,
      null, // catalogItem
      userConfigValues,
      environmentValues,
    );
  }

  test("generates basic podSpec for stdio-based MCP server without HTTP port", () => {
    const mcpServer: McpServer = {
      id: "test-server-id",
      name: "test-server",
      catalogId: "catalog-123",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "my-docker-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Verify metadata
    expect(podSpec.metadata?.name).toBe("mcp-test-server");
    expect(podSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "test-server-id",
      "mcp-server-name": "test-server",
    });

    // Verify spec
    expect(podSpec.spec?.containers).toHaveLength(1);
    const container = podSpec.spec?.containers[0];
    expect(container?.name).toBe("mcp-server");
    expect(container?.image).toBe(dockerImage);
    expect(container?.command).toEqual(["node"]);
    expect(container?.args).toEqual(["server.js"]);
    expect(container?.stdin).toBe(true);
    expect(container?.tty).toBe(false);
    expect(container?.ports).toBeUndefined();
    expect(podSpec.spec?.restartPolicy).toBe("Always");
  });

  test("generates podSpec for HTTP-based MCP server with exposed port", () => {
    const mcpServer: McpServer = {
      id: "http-server-id",
      name: "http-server",
      catalogId: "catalog-456",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "my-http-server:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "npm",
      arguments: ["start"],
      transportType: "streamable-http",
      httpPort: 3000,
    };
    const needsHttp = true;
    const httpPort = 3000;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.ports).toEqual([
      {
        containerPort: 3000,
        protocol: "TCP",
      },
    ]);
  });

  test("generates podSpec without command when no command is provided", () => {
    const mcpServer: McpServer = {
      id: "no-cmd-server-id",
      name: "no-cmd-server",
      catalogId: "catalog-789",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "default-cmd-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      // No command specified
      arguments: ["--verbose"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.command).toBeUndefined();
    expect(container?.args).toEqual(["--verbose"]);
  });

  test("generates podSpec with environment variables", () => {
    const mcpServer: McpServer = {
      id: "env-server-id",
      name: "env-server",
      catalogId: "catalog-env",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const dockerImage = "env-server:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["app.js"],
      environment: [
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
        },
        {
          key: "PORT",
          type: "plain_text",
          value: "3000",
          promptOnInstallation: false,
          required: false,
        },
        {
          key: "DEBUG",
          type: "plain_text",
          value: "true",
          promptOnInstallation: false,
          required: false,
        },
      ],
    };

    // Mock environment values that would be passed from secrets
    const environmentValues: Record<string, string> = {
      API_KEY: "secret123",
      PORT: "3000",
      DEBUG: "true",
    };

    const mockK8sApi = {} as k8s.CoreV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const k8sPod = new K8sPod(
      mcpServer,
      mockK8sApi,
      mockK8sAttach,
      mockK8sLog,
      "default",
      undefined,
      environmentValues,
    );

    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.env).toEqual([
      { name: "API_KEY", value: "secret123" },
      { name: "PORT", value: "3000" },
      { name: "DEBUG", value: "true" },
    ]);
  });

  test("generates podSpec with sanitized metadata labels", () => {
    const mcpServer: McpServer = {
      id: "special-chars-123!@#",
      name: "Server With Spaces & Special!",
      catalogId: "catalog-special",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Verify that labels are RFC 1123 compliant
    const labels = podSpec.metadata?.labels;
    expect(labels?.app).toBe("mcp-server");
    expect(labels?.["mcp-server-id"]).toBe("special-chars-123");
    expect(labels?.["mcp-server-name"]).toBe("server-with-spaces-special");

    // Verify all labels match RFC 1123 pattern
    for (const [key, value] of Object.entries(labels || {})) {
      expect(key).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      expect(value).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    }
  });

  test("generates podSpec with custom Docker image", () => {
    const mcpServer: McpServer = {
      id: "custom-image-id",
      name: "custom-image-server",
      catalogId: "catalog-custom",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "ghcr.io/my-org/custom-mcp-server:v2.1.0";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "python",
      arguments: ["-m", "server"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.image).toBe("ghcr.io/my-org/custom-mcp-server:v2.1.0");
  });

  test("generates podSpec with empty arguments array when not provided", () => {
    const mcpServer: McpServer = {
      id: "no-args-id",
      name: "no-args-server",
      catalogId: "catalog-no-args",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      // No arguments provided
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.args).toEqual([]);
  });

  test("generates podSpec with interpolated user_config values in arguments", () => {
    const mcpServer: McpServer = {
      id: "args-interpolation-id",
      name: "args-interpolation-server",
      catalogId: "catalog-args-interpolation",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const userConfigValues = {
      api_json_path: "/path/to/api.json",
      output_dir: "/output",
    };

    const k8sPod = createMockK8sPod(mcpServer, userConfigValues);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "npx",
      arguments: [
        "-y",
        "mcp-typescribe@latest",
        "run-server",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing interpolation of placeholders
        "${user_config.api_json_path}",
        "--output",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing interpolation of placeholders
        "${user_config.output_dir}",
      ],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.args).toEqual([
      "-y",
      "mcp-typescribe@latest",
      "run-server",
      "/path/to/api.json",
      "--output",
      "/output",
    ]);
  });

  test("generates podSpec with arguments without interpolation when no user config values provided", () => {
    const mcpServer: McpServer = {
      id: "no-interpolation-id",
      name: "no-interpolation-server",
      catalogId: "catalog-no-interpolation",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    // No userConfigValues provided
    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: [
        "index.js",
        "--file",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing placeholder is preserved when no user config
        "${user_config.file_path}",
      ],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    // Should keep placeholder as-is when no user config values
    expect(container?.args).toEqual([
      "index.js",
      "--file",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing placeholder is preserved when no user config
      "${user_config.file_path}",
    ]);
  });

  test("generates podSpec with interpolated environment values in arguments (filesystem server case)", () => {
    const mcpServer: McpServer = {
      id: "env-interpolation-id",
      name: "env-interpolation-server",
      catalogId: "catalog-env-interpolation",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    // Use environmentValues instead of userConfigValues (internal catalog pattern)
    const environmentValues = {
      allowed_directories: "/home/user/documents",
      read_only: "false",
    };

    const k8sPod = createMockK8sPod(mcpServer, undefined, environmentValues);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "npx",
      arguments: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing interpolation of placeholders
        "${user_config.allowed_directories}",
      ],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/home/user/documents",
    ]);
  });

  test("generates podSpec with environmentValues taking precedence over userConfigValues in arguments", () => {
    const mcpServer: McpServer = {
      id: "precedence-id",
      name: "precedence-server",
      catalogId: "catalog-precedence",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const userConfigValues = {
      path: "/old/path",
    };

    const environmentValues = {
      path: "/new/path",
    };

    const k8sPod = createMockK8sPod(
      mcpServer,
      userConfigValues,
      environmentValues,
    );

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "test",
      arguments: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing interpolation of placeholders
        "${user_config.path}",
      ],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    // environmentValues should take precedence
    expect(container?.args).toEqual(["/new/path"]);
  });

  test("generates podSpec with custom HTTP port", () => {
    const mcpServer: McpServer = {
      id: "custom-port-id",
      name: "custom-port-server",
      catalogId: "catalog-custom-port",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sPod = createMockK8sPod(mcpServer);

    const dockerImage = "custom-port:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      transportType: "streamable-http",
      httpPort: 9000,
    };
    const needsHttp = true;
    const httpPort = 9000;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];
    expect(container?.ports).toEqual([
      {
        containerPort: 9000,
        protocol: "TCP",
      },
    ]);
  });

  test("generates podSpec with complex environment configuration", () => {
    const mcpServer: McpServer = {
      id: "complex-env-id",
      name: "complex-env-server",
      catalogId: "catalog-complex",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const dockerImage = "complex:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "python",
      arguments: ["-m", "uvicorn", "main:app"],
      environment: [
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
        },
        {
          key: "DATABASE_URL",
          type: "secret",
          promptOnInstallation: true,
          required: false,
        },
        {
          key: "WORKERS",
          type: "plain_text",
          value: "4",
          promptOnInstallation: false,
          required: false,
        },
        {
          key: "DEBUG",
          type: "plain_text",
          value: "false",
          promptOnInstallation: false,
          required: false,
        },
      ],
      transportType: "streamable-http",
      httpPort: 8000,
    };

    // Mock environment values that would be passed from secrets
    const environmentValues: Record<string, string> = {
      API_KEY: "sk-1234567890",
      DATABASE_URL: "postgresql://localhost:5432/db",
      WORKERS: "4",
      DEBUG: "false",
    };

    const mockK8sApi = {} as k8s.CoreV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const k8sPod = new K8sPod(
      mcpServer,
      mockK8sApi,
      mockK8sAttach,
      mockK8sLog,
      "default",
      undefined,
      environmentValues,
    );

    const needsHttp = true;
    const httpPort = 8000;

    const podSpec = k8sPod.generatePodSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = podSpec.spec?.containers[0];

    // Verify environment variables (quotes should be stripped by createPodEnvFromConfig)
    expect(container?.env).toEqual([
      { name: "API_KEY", value: "sk-1234567890" },
      { name: "DATABASE_URL", value: "postgresql://localhost:5432/db" },
      { name: "WORKERS", value: "4" },
      { name: "DEBUG", value: "false" },
    ]);

    // Verify command and args
    expect(container?.command).toEqual(["python"]);
    expect(container?.args).toEqual(["-m", "uvicorn", "main:app"]);

    // Verify HTTP port
    expect(container?.ports).toEqual([
      {
        containerPort: 8000,
        protocol: "TCP",
      },
    ]);
  });
});

describe("K8sPod.createK8sSecret", () => {
  // Helper function to create a K8sPod instance with mocked K8s API
  function createK8sPodWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    secretData?: Record<string, string>,
  ): K8sPod {
    const mockMcpServer = {
      id: "test-server-id",
      name: "test-server",
      catalogId: "test-catalog-id",
      secretId: null,
      ownerId: null,
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;

    return new K8sPod(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      secretData,
    );
  }

  test("creates K8s secret successfully", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
    };

    const secretData = {
      API_KEY: "secret-123",
      DATABASE_URL: "postgresql://localhost:5432/db",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);
    await k8sPod.createK8sSecret(secretData);

    expect(mockCreateSecret).toHaveBeenCalledWith({
      namespace: "default",
      body: {
        metadata: {
          name: "mcp-server-test-server-id-secrets",
          labels: {
            app: "mcp-server",
            "mcp-server-id": "test-server-id",
            "mcp-server-name": "test-server",
          },
        },
        type: "Opaque",
        data: {
          API_KEY: Buffer.from("secret-123").toString("base64"),
          DATABASE_URL: Buffer.from("postgresql://localhost:5432/db").toString(
            "base64",
          ),
        },
      },
    });
  });

  test("skips secret creation when no secret data provided", async () => {
    const mockCreateSecret = vi.fn();
    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi);
    await k8sPod.createK8sSecret({});

    expect(mockCreateSecret).not.toHaveBeenCalled();
  });

  test("updates existing secret when creation fails with 409 conflict (statusCode)", async () => {
    const conflictError = {
      statusCode: 409,
      message: 'secrets "mcp-server-test-server-id-secrets" already exists',
    };

    const mockCreateSecret = vi.fn().mockRejectedValue(conflictError);
    const mockReplaceSecret = vi.fn().mockResolvedValue({});

    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
      replaceNamespacedSecret: mockReplaceSecret,
    };

    const secretData = {
      API_KEY: "updated-secret-456",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);
    await k8sPod.createK8sSecret(secretData);

    expect(mockCreateSecret).toHaveBeenCalledTimes(1);
    expect(mockReplaceSecret).toHaveBeenCalledWith({
      name: "mcp-server-test-server-id-secrets",
      namespace: "default",
      body: {
        metadata: {
          name: "mcp-server-test-server-id-secrets",
          labels: {
            app: "mcp-server",
            "mcp-server-id": "test-server-id",
            "mcp-server-name": "test-server",
          },
        },
        type: "Opaque",
        data: {
          API_KEY: Buffer.from("updated-secret-456").toString("base64"),
        },
      },
    });
  });

  test("updates existing secret when creation fails with 409 conflict (code)", async () => {
    const conflictError = {
      code: 409,
      message: 'secrets "mcp-server-test-server-id-secrets" already exists',
    };

    const mockCreateSecret = vi.fn().mockRejectedValue(conflictError);
    const mockReplaceSecret = vi.fn().mockResolvedValue({});

    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
      replaceNamespacedSecret: mockReplaceSecret,
    };

    const secretData = {
      DATABASE_PASSWORD: "new-password",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);
    await k8sPod.createK8sSecret(secretData);

    expect(mockCreateSecret).toHaveBeenCalledTimes(1);
    expect(mockReplaceSecret).toHaveBeenCalledTimes(1);
  });

  test("throws error for non-conflict errors during creation", async () => {
    const networkError = {
      statusCode: 500,
      message: "Internal server error",
    };

    const mockCreateSecret = vi.fn().mockRejectedValue(networkError);
    const mockReplaceSecret = vi.fn();

    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
      replaceNamespacedSecret: mockReplaceSecret,
    };

    const secretData = {
      API_KEY: "secret-123",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);

    await expect(k8sPod.createK8sSecret(secretData)).rejects.toEqual(
      networkError,
    );
    expect(mockCreateSecret).toHaveBeenCalledTimes(1);
    expect(mockReplaceSecret).not.toHaveBeenCalled();
  });

  test("throws error when replace operation fails", async () => {
    const conflictError = {
      statusCode: 409,
      message: 'secrets "mcp-server-test-server-id-secrets" already exists',
    };

    const replaceError = {
      statusCode: 403,
      message: "Forbidden",
    };

    const mockCreateSecret = vi.fn().mockRejectedValue(conflictError);
    const mockReplaceSecret = vi.fn().mockRejectedValue(replaceError);

    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
      replaceNamespacedSecret: mockReplaceSecret,
    };

    const secretData = {
      API_KEY: "secret-123",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);

    await expect(k8sPod.createK8sSecret(secretData)).rejects.toEqual(
      replaceError,
    );
    expect(mockCreateSecret).toHaveBeenCalledTimes(1);
    expect(mockReplaceSecret).toHaveBeenCalledTimes(1);
  });

  test("handles multiple secret data fields correctly", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
    };

    const secretData = {
      API_KEY: "key-123",
      DATABASE_URL: "postgres://localhost:5432",
      SECRET_TOKEN: "token-456",
      PASSWORD: "password123",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);
    await k8sPod.createK8sSecret(secretData);

    const expectedData = {
      API_KEY: Buffer.from("key-123").toString("base64"),
      DATABASE_URL: Buffer.from("postgres://localhost:5432").toString("base64"),
      SECRET_TOKEN: Buffer.from("token-456").toString("base64"),
      PASSWORD: Buffer.from("password123").toString("base64"),
    };

    expect(mockCreateSecret).toHaveBeenCalledWith({
      namespace: "default",
      body: {
        metadata: {
          name: "mcp-server-test-server-id-secrets",
          labels: {
            app: "mcp-server",
            "mcp-server-id": "test-server-id",
            "mcp-server-name": "test-server",
          },
        },
        type: "Opaque",
        data: expectedData,
      },
    });
  });

  test("handles empty string values in secret data", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
    };

    const secretData = {
      API_KEY: "",
      DATABASE_URL: "postgres://localhost:5432",
      EMPTY_SECRET: "",
    };

    const k8sPod = createK8sPodWithMockedApi(mockK8sApi, secretData);
    await k8sPod.createK8sSecret(secretData);

    const expectedData = {
      API_KEY: Buffer.from("").toString("base64"),
      DATABASE_URL: Buffer.from("postgres://localhost:5432").toString("base64"),
      EMPTY_SECRET: Buffer.from("").toString("base64"),
    };

    expect(mockCreateSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          data: expectedData,
        }),
      }),
    );
  });
});

describe("K8sPod.constructK8sSecretName", () => {
  test.each([
    {
      testName: "constructs secret name with valid UUID",
      mcpServerId: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-123e4567-e89b-12d3-a456-426614174000-secrets",
    },
    {
      testName: "constructs secret name with simple ID",
      mcpServerId: "simple-id",
      expected: "mcp-server-simple-id-secrets",
    },
    {
      testName: "constructs secret name with numeric ID",
      mcpServerId: "12345",
      expected: "mcp-server-12345-secrets",
    },
    {
      testName: "constructs secret name with alphanumeric ID",
      mcpServerId: "abc123def456",
      expected: "mcp-server-abc123def456-secrets",
    },
  ])("$testName", ({ mcpServerId, expected }) => {
    const result = K8sPod.constructK8sSecretName(mcpServerId);
    expect(result).toBe(expected);
    expect(result).toMatch(/^mcp-server-.+-secrets$/);
  });
});
