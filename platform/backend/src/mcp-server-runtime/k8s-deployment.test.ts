import type * as k8s from "@kubernetes/client-node";
import type { Attach, Log } from "@kubernetes/client-node";
import type { LocalConfigSchema } from "@shared";
import { vi } from "vitest";
import type { z } from "zod";
import config from "@/config";
import { describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import K8sDeployment, {
  fetchPlatformPodNodeSelector,
  getCachedPlatformNodeSelector,
  resetPlatformNodeSelectorCache,
} from "./k8s-deployment";

// Helper function to create a K8sDeployment instance with mocked dependencies
function createK8sDeploymentInstance(
  environmentValues?: Record<string, string | number | boolean>,
  userConfigValues?: Record<string, string>,
): K8sDeployment {
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
  const mockK8sAppsApi = {} as k8s.AppsV1Api;
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

  return new K8sDeployment(
    mockMcpServer,
    mockK8sApi,
    mockK8sAppsApi,
    mockK8sAttach,
    mockK8sLog,
    "default",
    null, // catalogItem
    userConfigValues,
    stringEnvironmentValues,
  );
}

describe("K8sDeployment.createContainerEnvFromConfig", () => {
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

    const instance = createK8sDeploymentInstance(environmentValues);
    const result = instance.createContainerEnvFromConfig();
    expect(result.envVars).toEqual(expected);
    expect(result.mountedSecrets).toEqual([]);
  });
});

describe("K8sDeployment.ensureStringIsRfc1123Compliant", () => {
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
    const result = K8sDeployment.ensureStringIsRfc1123Compliant(input);
    expect(result).toBe(expected);

    // Verify all results are valid Kubernetes DNS subdomain names
    expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  });
});

describe("K8sDeployment.constructDeploymentName", () => {
  test.each([
    // [server name, server id, expected deployment name]
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
  ])("converts server name '$name' with id '$id' to deployment name '$expected'", ({
    name,
    id,
    expected,
  }) => {
    // biome-ignore lint/suspicious/noExplicitAny: Minimal mock for testing
    const mockServer = { name, id } as any;
    const result = K8sDeployment.constructDeploymentName(mockServer);
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

    const result = K8sDeployment.constructDeploymentName(mockServer);

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

    const result1 = K8sDeployment.constructDeploymentName(mockServer);
    const result2 = K8sDeployment.constructDeploymentName(mockServer);

    expect(result1).toBe(result2);
    expect(result1).toBe("mcp-firecrawl-joey");
  });
});

describe("K8sDeployment.sanitizeMetadataLabels", () => {
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
    const result = K8sDeployment.sanitizeMetadataLabels(
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

describe("K8sDeployment.generateDeploymentSpec", () => {
  // Helper function to create a mock K8sDeployment instance
  function createMockK8sDeployment(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): K8sDeployment {
    const mockK8sApi = {} as k8s.CoreV1Api;
    const mockK8sAppsApi = {} as k8s.AppsV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const namespace = "default";

    return new K8sDeployment(
      mcpServer,
      mockK8sApi,
      mockK8sAppsApi,
      mockK8sAttach,
      mockK8sLog,
      namespace,
      null, // catalogItem
      userConfigValues,
      environmentValues,
    );
  }

  test("generates basic deploymentSpec for stdio-based MCP server without HTTP port", () => {
    const mcpServer: McpServer = {
      id: "test-server-id",
      name: "test-server",
      catalogId: "catalog-123",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "my-docker-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Verify metadata
    expect(deploymentSpec.metadata?.name).toBe("mcp-test-server");
    expect(deploymentSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "test-server-id",
      "mcp-server-name": "test-server",
    });

    // Verify deployment spec
    expect(deploymentSpec.spec?.replicas).toBe(1);
    expect(deploymentSpec.spec?.selector.matchLabels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "test-server-id",
      "mcp-server-name": "test-server",
    });

    // Verify pod template spec
    const templateSpec = deploymentSpec.spec?.template.spec;
    expect(templateSpec?.containers).toHaveLength(1);
    const container = templateSpec?.containers[0];
    expect(container?.name).toBe("mcp-server");
    expect(container?.image).toBe(dockerImage);
    expect(container?.command).toEqual(["node"]);
    expect(container?.args).toEqual(["server.js"]);
    expect(container?.stdin).toBe(true);
    expect(container?.tty).toBe(false);
    expect(container?.ports).toBeUndefined();
    expect(templateSpec?.restartPolicy).toBe("Always");
  });

  test("generates deploymentSpec for HTTP-based MCP server with exposed port", () => {
    const mcpServer: McpServer = {
      id: "http-server-id",
      name: "http-server",
      catalogId: "catalog-456",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "my-http-server:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "npm",
      arguments: ["start"],
      transportType: "streamable-http",
      httpPort: 3000,
    };
    const needsHttp = true;
    const httpPort = 3000;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.ports).toEqual([
      {
        containerPort: 3000,
        protocol: "TCP",
      },
    ]);
  });

  test("generates deploymentSpec without command when no command is provided", () => {
    const mcpServer: McpServer = {
      id: "no-cmd-server-id",
      name: "no-cmd-server",
      catalogId: "catalog-789",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "default-cmd-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      // No command specified
      arguments: ["--verbose"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.command).toBeUndefined();
    expect(container?.args).toEqual(["--verbose"]);
  });

  test("generates deploymentSpec with environment variables", () => {
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
    const mockK8sAppsApi = {} as k8s.AppsV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const k8sDeployment = new K8sDeployment(
      mcpServer,
      mockK8sApi,
      mockK8sAppsApi,
      mockK8sAttach,
      mockK8sLog,
      "default",
      undefined,
      undefined,
      environmentValues,
    );

    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.env).toEqual([
      { name: "API_KEY", value: "secret123" },
      { name: "PORT", value: "3000" },
      { name: "DEBUG", value: "true" },
    ]);
  });

  test("generates deploymentSpec with sanitized metadata labels", () => {
    const mcpServer: McpServer = {
      id: "special-chars-123!@#",
      name: "Server With Spaces & Special!",
      catalogId: "catalog-special",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Verify that labels are RFC 1123 compliant
    const labels = deploymentSpec.metadata?.labels;
    expect(labels?.app).toBe("mcp-server");
    expect(labels?.["mcp-server-id"]).toBe("special-chars-123");
    expect(labels?.["mcp-server-name"]).toBe("server-with-spaces-special");

    // Verify all labels match RFC 1123 pattern
    for (const [key, value] of Object.entries(labels || {})) {
      expect(key).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      expect(value).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    }
  });

  test("generates deploymentSpec with custom Docker image", () => {
    const mcpServer: McpServer = {
      id: "custom-image-id",
      name: "custom-image-server",
      catalogId: "catalog-custom",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "ghcr.io/my-org/custom-mcp-server:v2.1.0";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "python",
      arguments: ["-m", "server"],
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.image).toBe("ghcr.io/my-org/custom-mcp-server:v2.1.0");
  });

  test("generates deploymentSpec with empty arguments array when not provided", () => {
    const mcpServer: McpServer = {
      id: "no-args-id",
      name: "no-args-server",
      catalogId: "catalog-no-args",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      // No arguments provided
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([]);
  });

  test("generates deploymentSpec with interpolated user_config values in arguments", () => {
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

    const k8sDeployment = createMockK8sDeployment(mcpServer, userConfigValues);

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

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([
      "-y",
      "mcp-typescribe@latest",
      "run-server",
      "/path/to/api.json",
      "--output",
      "/output",
    ]);
  });

  test("generates deploymentSpec with arguments without interpolation when no user config values provided", () => {
    const mcpServer: McpServer = {
      id: "no-interpolation-id",
      name: "no-interpolation-server",
      catalogId: "catalog-no-interpolation",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    // No userConfigValues provided
    const k8sDeployment = createMockK8sDeployment(mcpServer);

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

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    // Should keep placeholder as-is when no user config values
    expect(container?.args).toEqual([
      "index.js",
      "--file",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing placeholder is preserved when no user config
      "${user_config.file_path}",
    ]);
  });

  test("generates deploymentSpec with interpolated environment values in arguments (filesystem server case)", () => {
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

    const k8sDeployment = createMockK8sDeployment(
      mcpServer,
      undefined,
      environmentValues,
    );

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

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/home/user/documents",
    ]);
  });

  test("generates deploymentSpec with environmentValues taking precedence over userConfigValues in arguments", () => {
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

    const k8sDeployment = createMockK8sDeployment(
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

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    // environmentValues should take precedence
    expect(container?.args).toEqual(["/new/path"]);
  });

  test("generates deploymentSpec with custom HTTP port", () => {
    const mcpServer: McpServer = {
      id: "custom-port-id",
      name: "custom-port-server",
      catalogId: "catalog-custom-port",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "custom-port:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      transportType: "streamable-http",
      httpPort: 9000,
    };
    const needsHttp = true;
    const httpPort = 9000;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.ports).toEqual([
      {
        containerPort: 9000,
        protocol: "TCP",
      },
    ]);
  });

  test("generates deploymentSpec with complex environment configuration", () => {
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
    const mockK8sAppsApi = {} as k8s.AppsV1Api;
    const mockK8sAttach = {} as k8s.Attach;
    const mockK8sLog = {} as k8s.Log;
    const k8sDeployment = new K8sDeployment(
      mcpServer,
      mockK8sApi,
      mockK8sAppsApi,
      mockK8sAttach,
      mockK8sLog,
      "default",
      undefined,
      undefined,
      environmentValues,
    );

    const needsHttp = true;
    const httpPort = 8000;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];

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

  test("rewrite localhost URLs when backend is external to MCP pods", () => {
    // Save original value
    const originalValue =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;

    // Mock config to simulate backend running in-cluster (production deployment)
    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = false;

    const mockCatalogItem = {
      id: "test-catalog-id",
      name: "test-catalog",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "GRAFANA_URL",
            type: "plain_text" as const,
            value: "",
            required: true,
            description: "Grafana URL",
            promptOnInstallation: true,
            prompt: false,
          },
          {
            key: "API_ENDPOINT",
            type: "plain_text" as const,
            value: "",
            required: false,
            description: "API endpoint",
            promptOnInstallation: true,
            prompt: false,
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance(
      {
        GRAFANA_URL: "http://localhost:3002/",
        API_ENDPOINT: "http://127.0.0.1:8080/api",
      },
      undefined,
    );

    // Use reflection to set the catalog item
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test-image",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const envVars =
      deploymentSpec.spec?.template.spec?.containers[0]?.env || [];

    // Find the rewritten URLs
    const grafanaUrl = envVars.find((env) => env.name === "GRAFANA_URL");
    const apiEndpoint = envVars.find((env) => env.name === "API_ENDPOINT");

    expect(grafanaUrl?.value).toBe("http://host.docker.internal:3002/");
    expect(apiEndpoint?.value).toBe("http://host.docker.internal:8080/api");

    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
      originalValue;
  });

  test("does not rewrite non-localhost URLs", () => {
    const mockCatalogItem = {
      id: "test-catalog-id",
      name: "test-catalog",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "GRAFANA_URL",
            type: "plain_text" as const,
            value: "",
            required: true,
            description: "Grafana URL",
            promptOnInstallation: true,
            prompt: false,
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance(
      {
        GRAFANA_URL: "https://grafana.example.com:3000/",
      },
      undefined,
    );

    // Use reflection to set the catalog item
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test-image",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const envVars =
      deploymentSpec.spec?.template.spec?.containers[0]?.env || [];
    const grafanaUrl = envVars.find((env) => env.name === "GRAFANA_URL");

    // Should NOT be rewritten
    expect(grafanaUrl?.value).toBe("https://grafana.example.com:3000/");
  });

  test("does not rewrite non-HTTP/HTTPS protocols (MongoDB, PostgreSQL, etc.)", () => {
    const mockCatalogItem = {
      id: "test-catalog-id",
      name: "test-catalog",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "DATABASE_URL",
            type: "plain_text" as const,
            value: "",
            required: true,
            description: "Database URL",
            promptOnInstallation: true,
            prompt: false,
          },
          {
            key: "MONGODB_URL",
            type: "plain_text" as const,
            value: "",
            required: false,
            description: "MongoDB URL",
            promptOnInstallation: true,
            prompt: false,
          },
          {
            key: "REDIS_URL",
            type: "plain_text" as const,
            value: "",
            required: false,
            description: "Redis URL",
            promptOnInstallation: true,
            prompt: false,
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance(
      {
        DATABASE_URL: "postgresql://localhost:5432/mydb",
        MONGODB_URL: "mongodb://127.0.0.1:27017/mydb",
        REDIS_URL: "redis://localhost:6379",
      },
      undefined,
    );

    // Use reflection to set the catalog item
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test-image",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const envVars =
      deploymentSpec.spec?.template.spec?.containers[0]?.env || [];

    const databaseUrl = envVars.find((env) => env.name === "DATABASE_URL");
    const mongodbUrl = envVars.find((env) => env.name === "MONGODB_URL");
    const redisUrl = envVars.find((env) => env.name === "REDIS_URL");

    // Should NOT be rewritten - only HTTP/HTTPS protocols are rewritten
    expect(databaseUrl?.value).toBe("postgresql://localhost:5432/mydb");
    expect(mongodbUrl?.value).toBe("mongodb://127.0.0.1:27017/mydb");
    expect(redisUrl?.value).toBe("redis://localhost:6379");
  });

  test("does not rewrite localhost URLs when backend shares environment with K8s cluster", () => {
    // Save original value
    const originalValue =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;

    // Mock config to simulate backend running in-cluster (production deployment)
    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = true;

    const mockCatalogItem = {
      id: "test-catalog-id",
      name: "test-catalog",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "GRAFANA_URL",
            type: "plain_text" as const,
            value: "",
            required: true,
            description: "Grafana URL",
            promptOnInstallation: true,
            prompt: false,
          },
          {
            key: "API_ENDPOINT",
            type: "plain_text" as const,
            value: "",
            required: false,
            description: "API endpoint",
            promptOnInstallation: true,
            prompt: false,
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance(
      {
        GRAFANA_URL: "http://localhost:3002/",
        API_ENDPOINT: "http://127.0.0.1:8080/api",
      },
      undefined,
    );

    // Use reflection to set the catalog item
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test-image",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const envVars =
      deploymentSpec.spec?.template.spec?.containers[0]?.env || [];

    // Find the URLs
    const grafanaUrl = envVars.find((env) => env.name === "GRAFANA_URL");
    const apiEndpoint = envVars.find((env) => env.name === "API_ENDPOINT");

    // Should NOT be rewritten when backend runs in cluster
    expect(grafanaUrl?.value).toBe("http://localhost:3002/");
    expect(apiEndpoint?.value).toBe("http://127.0.0.1:8080/api");

    // Restore original value
    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
      originalValue;
  });

  test("generates deploymentSpec with nodeSelector when provided", () => {
    const mcpServer: McpServer = {
      id: "node-selector-test-id",
      name: "node-selector-server",
      catalogId: "catalog-ns",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const nodeSelector = {
      "karpenter.sh/nodepool": "general-purpose",
      "kubernetes.io/os": "linux",
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      nodeSelector,
    );

    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toEqual({
      "karpenter.sh/nodepool": "general-purpose",
      "kubernetes.io/os": "linux",
    });
  });

  test("generates deploymentSpec without nodeSelector when null is provided", () => {
    const mcpServer: McpServer = {
      id: "no-node-selector-id",
      name: "no-node-selector-server",
      catalogId: "catalog-no-ns",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      null,
    );

    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toBeUndefined();
  });

  test("generates deploymentSpec without nodeSelector when undefined is provided", () => {
    const mcpServer: McpServer = {
      id: "undefined-node-selector-id",
      name: "undefined-node-selector-server",
      catalogId: "catalog-undefined-ns",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      undefined,
    );

    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toBeUndefined();
  });

  test("generates deploymentSpec without nodeSelector when empty object is provided", () => {
    const mcpServer: McpServer = {
      id: "empty-node-selector-id",
      name: "empty-node-selector-server",
      catalogId: "catalog-empty-ns",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      {},
    );

    // Empty object should not add nodeSelector
    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toBeUndefined();
  });

  test("combines nodeSelector with serviceAccountName when both are configured", () => {
    const mcpServer: McpServer = {
      id: "combined-config-id",
      name: "combined-config-server",
      catalogId: "catalog-combined",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      serviceAccount: "archestra-platform-mcp-k8s-operator",
    };
    const nodeSelector = {
      "karpenter.sh/nodepool": "k8s-operator-pool",
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      nodeSelector,
    );

    // Both should be set
    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toEqual({
      "karpenter.sh/nodepool": "k8s-operator-pool",
    });
    // serviceAccount from localConfig is used directly
    expect(deploymentSpec.spec?.template.spec?.serviceAccountName).toBe(
      "archestra-platform-mcp-k8s-operator",
    );
  });

  test("generates deploymentSpec with volume and volumeMount for mounted secrets", () => {
    const mockCatalogItem = {
      id: "catalog-mounted",
      name: "test-catalog",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "TLS_CERT",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true, // Should be mounted as file
          },
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: false, // Should be env var
          },
          {
            key: "PORT",
            type: "plain_text" as const,
            value: "3000",
            promptOnInstallation: false,
          },
        ],
      },
    };

    const environmentValues: Record<string, string> = {
      TLS_CERT: "-----BEGIN CERTIFICATE-----...",
      API_KEY: "secret-api-key",
    };

    const deployment = createK8sDeploymentInstance(
      environmentValues,
      undefined,
    );
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;
    const container = podSpec?.containers[0];

    // Verify volumes are created for mounted secrets
    expect(podSpec?.volumes).toHaveLength(1);
    expect(podSpec?.volumes?.[0]).toEqual({
      name: "mounted-secrets",
      secret: {
        secretName: "mcp-server-test-server-id-secrets",
        items: [{ key: "TLS_CERT", path: "TLS_CERT" }],
      },
    });

    // Verify volumeMounts
    expect(container?.volumeMounts).toHaveLength(1);
    expect(container?.volumeMounts?.[0]).toEqual({
      name: "mounted-secrets",
      mountPath: "/secrets/TLS_CERT",
      subPath: "TLS_CERT",
      readOnly: true,
    });

    // Verify TLS_CERT is NOT in env vars (it's mounted)
    const tlsCertEnv = container?.env?.find((e) => e.name === "TLS_CERT");
    expect(tlsCertEnv).toBeUndefined();

    // Verify API_KEY is in env vars with secretKeyRef (not mounted)
    const apiKeyEnv = container?.env?.find((e) => e.name === "API_KEY");
    expect(apiKeyEnv?.valueFrom?.secretKeyRef).toEqual({
      name: "mcp-server-test-server-id-secrets",
      key: "API_KEY",
    });

    // Verify PORT is a plain value env var
    const portEnv = container?.env?.find((e) => e.name === "PORT");
    expect(portEnv?.value).toBe("3000");
  });

  test("generates deploymentSpec with no volumes when no mounted secrets", () => {
    const mockCatalogItem = {
      id: "catalog-no-mounted",
      name: "test-catalog",
      localConfig: {
        command: "node",
        environment: [
          {
            key: "API_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: false, // Not mounted
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance(
      { API_KEY: "secret-value" },
      undefined,
    );
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;

    // No volumes should be present
    expect(podSpec?.volumes).toBeUndefined();
    expect(podSpec?.containers[0]?.volumeMounts).toBeUndefined();

    // API_KEY should be a secretKeyRef env var
    const apiKeyEnv = podSpec?.containers[0]?.env?.find(
      (e) => e.name === "API_KEY",
    );
    expect(apiKeyEnv?.valueFrom?.secretKeyRef).toEqual({
      name: "mcp-server-test-server-id-secrets",
      key: "API_KEY",
    });
  });

  test("generates deploymentSpec with multiple mounted secrets sharing one volume", () => {
    const mockCatalogItem = {
      id: "catalog-multi",
      name: "test-catalog",
      localConfig: {
        command: "node",
        environment: [
          {
            key: "TLS_CERT",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
          {
            key: "TLS_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
          {
            key: "CA_BUNDLE",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
        ],
      },
    };

    const environmentValues: Record<string, string> = {
      TLS_CERT: "-----BEGIN CERTIFICATE-----...",
      TLS_KEY: "-----BEGIN PRIVATE KEY-----...",
      CA_BUNDLE: "-----BEGIN CERTIFICATE-----...",
    };

    const deployment = createK8sDeploymentInstance(
      environmentValues,
      undefined,
    );
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;
    const container = podSpec?.containers[0];

    // One volume with all mounted secrets
    expect(podSpec?.volumes).toHaveLength(1);
    expect(podSpec?.volumes?.[0].secret?.items).toHaveLength(3);

    // Three volumeMounts
    expect(container?.volumeMounts).toHaveLength(3);
    expect(container?.volumeMounts?.map((v) => v.mountPath).sort()).toEqual([
      "/secrets/CA_BUNDLE",
      "/secrets/TLS_CERT",
      "/secrets/TLS_KEY",
    ]);

    // All mounts should be readOnly
    for (const mount of container?.volumeMounts || []) {
      expect(mount.readOnly).toBe(true);
    }

    // No env vars for mounted secrets
    expect(container?.env).toEqual([]);
  });

  test("mounted flag is ignored for non-secret types", () => {
    const mockCatalogItem = {
      id: "catalog-ignore",
      name: "test-catalog",
      localConfig: {
        command: "node",
        environment: [
          {
            key: "PORT",
            type: "plain_text" as const,
            value: "3000",
            promptOnInstallation: false,
            mounted: true, // Should be ignored for plain_text
          },
        ],
      },
    };

    const deployment = createK8sDeploymentInstance({}, undefined);
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;

    // No volumes since plain_text can't be mounted
    expect(podSpec?.volumes).toBeUndefined();

    // PORT should still be a regular env var
    const portEnv = podSpec?.containers[0]?.env?.find((e) => e.name === "PORT");
    expect(portEnv?.value).toBe("3000");
  });

  test("skips mounted secrets with empty values - no volumes created", () => {
    const mockCatalogItem = {
      id: "catalog-empty-mounted",
      name: "test-catalog",
      localConfig: {
        command: "node",
        environment: [
          {
            key: "TLS_CERT",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
          {
            key: "TLS_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
        ],
      },
    };

    // Empty values for both mounted secrets
    const environmentValues: Record<string, string> = {
      TLS_CERT: "",
      TLS_KEY: "   ", // Whitespace only
    };

    const deployment = createK8sDeploymentInstance(
      environmentValues,
      undefined,
    );
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;
    const container = podSpec?.containers[0];

    // No volumes should be created for empty secrets
    expect(podSpec?.volumes).toBeUndefined();
    expect(container?.volumeMounts).toBeUndefined();

    // No env vars either (mounted secrets skip env var injection)
    expect(container?.env).toEqual([]);
  });

  test("only mounts secrets with values, skips empty ones", () => {
    const mockCatalogItem = {
      id: "catalog-partial-mounted",
      name: "test-catalog",
      localConfig: {
        command: "node",
        environment: [
          {
            key: "TLS_CERT",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
          {
            key: "TLS_KEY",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
          {
            key: "CA_BUNDLE",
            type: "secret" as const,
            promptOnInstallation: true,
            mounted: true,
          },
        ],
      },
    };

    // Only TLS_CERT has a value
    const environmentValues: Record<string, string> = {
      TLS_CERT: "-----BEGIN CERTIFICATE-----...",
      TLS_KEY: "", // Empty - should be skipped
      CA_BUNDLE: "  ", // Whitespace - should be skipped
    };

    const deployment = createK8sDeploymentInstance(
      environmentValues,
      undefined,
    );
    // @ts-expect-error - accessing private property for testing
    deployment.catalogItem = mockCatalogItem;

    const deploymentSpec = deployment.generateDeploymentSpec(
      "test:latest",
      mockCatalogItem.localConfig as z.infer<typeof LocalConfigSchema>,
      false,
      8080,
    );

    const podSpec = deploymentSpec.spec?.template.spec;
    const container = podSpec?.containers[0];

    // Only one volume with one item (TLS_CERT)
    expect(podSpec?.volumes).toHaveLength(1);
    expect(podSpec?.volumes?.[0].secret?.items).toHaveLength(1);
    expect(podSpec?.volumes?.[0].secret?.items?.[0].key).toBe("TLS_CERT");

    // Only one volumeMount for TLS_CERT
    expect(container?.volumeMounts).toHaveLength(1);
    expect(container?.volumeMounts?.[0].mountPath).toBe("/secrets/TLS_CERT");

    // No env vars (all are mounted secrets, empty ones skipped entirely)
    expect(container?.env).toEqual([]);
  });

  // Advanced K8s Configuration Tests
  test("generates deploymentSpec with custom replicas from advancedK8sConfig", () => {
    const mcpServer: McpServer = {
      id: "replicas-server-id",
      name: "replicas-server",
      catalogId: "catalog-replicas",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        replicas: 3,
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    expect(deploymentSpec.spec?.replicas).toBe(3);
  });

  test("generates deploymentSpec with custom labels from advancedK8sConfig", () => {
    const mcpServer: McpServer = {
      id: "labels-server-id",
      name: "labels-server",
      catalogId: "catalog-labels",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        labels: {
          environment: "production",
          team: "platform",
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Custom labels should be merged with required labels
    expect(deploymentSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "labels-server-id",
      "mcp-server-name": "labels-server",
      environment: "production",
      team: "platform",
    });

    // Pod template should also have the merged labels
    expect(deploymentSpec.spec?.template.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "labels-server-id",
      "mcp-server-name": "labels-server",
      environment: "production",
      team: "platform",
    });
  });

  test("generates deploymentSpec with annotations from advancedK8sConfig", () => {
    const mcpServer: McpServer = {
      id: "annotations-server-id",
      name: "annotations-server",
      catalogId: "catalog-annotations",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Annotations should be on the pod template
    expect(deploymentSpec.spec?.template.metadata?.annotations).toEqual({
      "prometheus.io/scrape": "true",
      "prometheus.io/port": "9090",
    });
  });

  test("generates deploymentSpec with custom resource requests from advancedK8sConfig", () => {
    const mcpServer: McpServer = {
      id: "resources-server-id",
      name: "resources-server",
      catalogId: "catalog-resources",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        resources: {
          requests: {
            memory: "256Mi",
            cpu: "100m",
          },
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.resources?.requests).toEqual({
      memory: "256Mi",
      cpu: "100m",
    });
  });

  test("generates deploymentSpec with resource limits from advancedK8sConfig", () => {
    const mcpServer: McpServer = {
      id: "limits-server-id",
      name: "limits-server",
      catalogId: "catalog-limits",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        resources: {
          requests: {
            memory: "256Mi",
            cpu: "100m",
          },
          limits: {
            memory: "512Mi",
            cpu: "500m",
          },
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.resources?.requests).toEqual({
      memory: "256Mi",
      cpu: "100m",
    });
    expect(container?.resources?.limits).toEqual({
      memory: "512Mi",
      cpu: "500m",
    });
  });

  test("generates deploymentSpec with combined advancedK8sConfig settings", () => {
    const mcpServer: McpServer = {
      id: "combined-server-id",
      name: "combined-server",
      catalogId: "catalog-combined",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        replicas: 2,
        labels: {
          environment: "staging",
        },
        annotations: {
          "app.kubernetes.io/managed-by": "archestra",
        },
        resources: {
          requests: {
            memory: "512Mi",
            cpu: "200m",
          },
          limits: {
            memory: "1Gi",
            cpu: "1000m",
          },
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Check replicas
    expect(deploymentSpec.spec?.replicas).toBe(2);

    // Check labels are merged
    expect(deploymentSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "combined-server-id",
      "mcp-server-name": "combined-server",
      environment: "staging",
    });

    // Check annotations on pod template
    expect(deploymentSpec.spec?.template.metadata?.annotations).toEqual({
      "app.kubernetes.io/managed-by": "archestra",
    });

    // Check resources
    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.resources?.requests).toEqual({
      memory: "512Mi",
      cpu: "200m",
    });
    expect(container?.resources?.limits).toEqual({
      memory: "1Gi",
      cpu: "1000m",
    });
  });

  test("uses default values when advancedK8sConfig is not provided", () => {
    const mcpServer: McpServer = {
      id: "default-server-id",
      name: "default-server",
      catalogId: "catalog-default",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      // No advancedK8sConfig
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Default replicas
    expect(deploymentSpec.spec?.replicas).toBe(1);

    // Default labels (only required ones)
    expect(deploymentSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "default-server-id",
      "mcp-server-name": "default-server",
    });

    // No annotations
    expect(deploymentSpec.spec?.template.metadata?.annotations).toBeUndefined();

    // Default resources
    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.resources?.requests).toEqual({
      memory: "128Mi",
      cpu: "50m",
    });
    expect(container?.resources?.limits).toBeUndefined();
  });

  test("custom labels do not override required labels", () => {
    const mcpServer: McpServer = {
      id: "override-server-id",
      name: "override-server",
      catalogId: "catalog-override",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test-image:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      advancedK8sConfig: {
        labels: {
          // Try to override required labels
          app: "custom-app",
          "mcp-server-id": "custom-id",
        },
      },
    };
    const needsHttp = false;
    const httpPort = 8080;

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      needsHttp,
      httpPort,
    );

    // Required labels should take precedence
    expect(deploymentSpec.metadata?.labels).toEqual({
      app: "mcp-server",
      "mcp-server-id": "override-server-id",
      "mcp-server-name": "override-server",
    });
  });
});

describe("K8sDeployment.createK8sSecret", () => {
  // Helper function to create a K8sDeployment instance with mocked K8s API
  function createK8sDeploymentWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    secretData?: Record<string, string>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );
    await k8sDeployment.createK8sSecret(secretData);

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

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    await k8sDeployment.createK8sSecret({});

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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );
    await k8sDeployment.createK8sSecret(secretData);

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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );
    await k8sDeployment.createK8sSecret(secretData);

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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );

    await expect(k8sDeployment.createK8sSecret(secretData)).rejects.toEqual(
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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );

    await expect(k8sDeployment.createK8sSecret(secretData)).rejects.toEqual(
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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );
    await k8sDeployment.createK8sSecret(secretData);

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

    const k8sDeployment = createK8sDeploymentWithMockedApi(
      mockK8sApi,
      secretData,
    );
    await k8sDeployment.createK8sSecret(secretData);

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

describe("K8sDeployment.constructK8sSecretName", () => {
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
    const result = K8sDeployment.constructK8sSecretName(mcpServerId);
    expect(result).toBe(expected);
    expect(result).toMatch(/^mcp-server-.+-secrets$/);
  });
});

describe("K8sDeployment.generateDeploymentSpec - serviceAccountName", () => {
  test("does not set serviceAccountName when not provided in localConfig", () => {
    const mockMcpServer = {
      id: "test-server",
      name: "Test Server",
      catalogId: "test-catalog",
      secretId: null,
      ownerId: null,
      teamId: null,
      serverType: "local",
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;

    const k8sDeployment = new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as k8s.Attach,
      {} as k8s.Log,
      "default",
      null,
      undefined,
      undefined,
    );

    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      "test-image:latest",
      localConfig,
      false,
      8080,
    );

    expect(
      deploymentSpec.spec?.template.spec?.serviceAccountName,
    ).toBeUndefined();
  });

  test("uses service account name from localConfig", () => {
    const mockMcpServer = {
      id: "k8s-server",
      name: "Kubernetes MCP",
      catalogId: "k8s-catalog",
      secretId: null,
      ownerId: null,
      teamId: null,
      serverType: "local",
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;

    const k8sDeployment = new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as k8s.Attach,
      {} as k8s.Log,
      "default",
      null,
      undefined,
      undefined,
    );

    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "docker",
      arguments: ["run", "-i", "--rm", "kubernetes-mcp:latest"],
      serviceAccount: "archestra-platform-mcp-k8s-operator",
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      "kubernetes-mcp:latest",
      localConfig,
      false,
      8080,
    );

    // Should use the service account name from localConfig directly
    expect(deploymentSpec.spec?.template.spec?.serviceAccountName).toBe(
      "archestra-platform-mcp-k8s-operator",
    );
  });
});

describe("K8sDeployment.deleteK8sSecret", () => {
  function createK8sDeploymentWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );
  }

  test("deletes K8s secret successfully", async () => {
    const mockDeleteSecret = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      deleteNamespacedSecret: mockDeleteSecret,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    await k8sDeployment.deleteK8sSecret();

    expect(mockDeleteSecret).toHaveBeenCalledWith({
      name: "mcp-server-test-server-id-secrets",
      namespace: "default",
    });
  });

  test("handles 404 error gracefully when secret does not exist (statusCode)", async () => {
    const notFoundError = { statusCode: 404, message: "Secret not found" };
    const mockDeleteSecret = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      deleteNamespacedSecret: mockDeleteSecret,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.deleteK8sSecret()).resolves.toBeUndefined();
  });

  test("handles 404 error gracefully when secret does not exist (code)", async () => {
    const notFoundError = { code: 404, message: "Secret not found" };
    const mockDeleteSecret = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      deleteNamespacedSecret: mockDeleteSecret,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.deleteK8sSecret()).resolves.toBeUndefined();
  });

  test("throws error for non-404 errors", async () => {
    const serverError = { statusCode: 500, message: "Internal server error" };
    const mockDeleteSecret = vi.fn().mockRejectedValue(serverError);
    const mockK8sApi = {
      deleteNamespacedSecret: mockDeleteSecret,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    await expect(k8sDeployment.deleteK8sSecret()).rejects.toEqual(serverError);
  });
});

describe("K8sDeployment.deleteK8sService", () => {
  function createK8sDeploymentWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );
  }

  test("deletes K8s service successfully", async () => {
    const mockDeleteService = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    await k8sDeployment.deleteK8sService();

    expect(mockDeleteService).toHaveBeenCalledWith({
      name: "mcp-test-server-service",
      namespace: "default",
    });
  });

  test("handles 404 error gracefully when service does not exist (statusCode)", async () => {
    const notFoundError = { statusCode: 404, message: "Service not found" };
    const mockDeleteService = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.deleteK8sService()).resolves.toBeUndefined();
  });

  test("handles 404 error gracefully when service does not exist (code)", async () => {
    const notFoundError = { code: 404, message: "Service not found" };
    const mockDeleteService = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.deleteK8sService()).resolves.toBeUndefined();
  });

  test("throws error for non-404 errors", async () => {
    const serverError = { statusCode: 500, message: "Internal server error" };
    const mockDeleteService = vi.fn().mockRejectedValue(serverError);
    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    await expect(k8sDeployment.deleteK8sService()).rejects.toEqual(serverError);
  });
});

describe("K8sDeployment.stopDeployment", () => {
  function createK8sDeploymentWithMockedApis(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    mockK8sAppsApi: Partial<k8s.AppsV1Api>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      mockK8sAppsApi as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );
  }

  test("stops deployment successfully", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis({}, mockK8sAppsApi);
    await k8sDeployment.stopDeployment();

    expect(mockDeleteDeployment).toHaveBeenCalledWith({
      name: "mcp-test-server",
      namespace: "default",
    });
  });

  test("handles 404 error gracefully when deployment does not exist (statusCode)", async () => {
    const notFoundError = { statusCode: 404, message: "Deployment not found" };
    const mockDeleteDeployment = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis({}, mockK8sAppsApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.stopDeployment()).resolves.toBeUndefined();
  });

  test("handles 404 error gracefully when deployment does not exist (code)", async () => {
    const notFoundError = { code: 404, message: "Deployment not found" };
    const mockDeleteDeployment = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis({}, mockK8sAppsApi);

    // Should not throw - 404 is handled gracefully
    await expect(k8sDeployment.stopDeployment()).resolves.toBeUndefined();
  });

  test("throws error for non-404 errors", async () => {
    const serverError = { statusCode: 500, message: "Internal server error" };
    const mockDeleteDeployment = vi.fn().mockRejectedValue(serverError);
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis({}, mockK8sAppsApi);

    await expect(k8sDeployment.stopDeployment()).rejects.toEqual(serverError);
  });
});

describe("K8sDeployment.removeDeployment", () => {
  function createK8sDeploymentWithMockedApis(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    mockK8sAppsApi: Partial<k8s.AppsV1Api>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      mockK8sAppsApi as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );
  }

  test("removes deployment, service, and secret", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockDeleteService = vi.fn().mockResolvedValue({});
    const mockDeleteSecret = vi.fn().mockResolvedValue({});

    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
      deleteNamespacedSecret: mockDeleteSecret,
    };
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis(
      mockK8sApi,
      mockK8sAppsApi,
    );
    await k8sDeployment.removeDeployment();

    // Should call all three delete operations
    expect(mockDeleteDeployment).toHaveBeenCalledWith({
      name: "mcp-test-server",
      namespace: "default",
    });
    expect(mockDeleteService).toHaveBeenCalledWith({
      name: "mcp-test-server-service",
      namespace: "default",
    });
    expect(mockDeleteSecret).toHaveBeenCalledWith({
      name: "mcp-server-test-server-id-secrets",
      namespace: "default",
    });
  });

  test("handles missing resources gracefully during removal", async () => {
    const notFoundError = { statusCode: 404, message: "Not found" };
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockDeleteService = vi.fn().mockRejectedValue(notFoundError);
    const mockDeleteSecret = vi.fn().mockRejectedValue(notFoundError);

    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
      deleteNamespacedSecret: mockDeleteSecret,
    };
    const mockK8sAppsApi = {
      deleteNamespacedDeployment: mockDeleteDeployment,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApis(
      mockK8sApi,
      mockK8sAppsApi,
    );

    // Should not throw - 404s are handled gracefully
    await expect(k8sDeployment.removeDeployment()).resolves.toBeUndefined();
  });
});

describe("K8sDeployment.statusSummary", () => {
  function createK8sDeploymentInstance(): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "test-namespace",
      null,
      undefined,
      undefined,
    );
  }

  test("returns correct status summary for not_created state", () => {
    const k8sDeployment = createK8sDeploymentInstance();

    const summary = k8sDeployment.statusSummary;

    expect(summary.state).toBe("not_created");
    expect(summary.message).toBe("Deployment not created");
    expect(summary.error).toBeNull();
    expect(summary.deploymentName).toBe("mcp-test-server");
    expect(summary.namespace).toBe("test-namespace");
  });

  test("returns correct deployment name and namespace", () => {
    const k8sDeployment = createK8sDeploymentInstance();

    const summary = k8sDeployment.statusSummary;

    expect(summary.deploymentName).toBe("mcp-test-server");
    expect(summary.namespace).toBe("test-namespace");
  });
});

describe("K8sDeployment.containerName", () => {
  test("returns the deployment name", () => {
    const mockMcpServer = {
      id: "test-server-id",
      name: "my-server",
      catalogId: "test-catalog-id",
    } as McpServer;

    const k8sDeployment = new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );

    expect(k8sDeployment.containerName).toBe("mcp-my-server");
  });
});

describe("K8sDeployment.k8sNamespace", () => {
  test("returns the configured namespace", () => {
    const mockMcpServer = {
      id: "test-server-id",
      name: "test-server",
      catalogId: "test-catalog-id",
    } as McpServer;

    const k8sDeployment = new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "custom-namespace",
      null,
      undefined,
      undefined,
    );

    expect(k8sDeployment.k8sNamespace).toBe("custom-namespace");
  });
});

describe("K8sDeployment.k8sDeploymentName", () => {
  test("returns the deployment name", () => {
    const mockMcpServer = {
      id: "test-server-id",
      name: "my-mcp-server",
      catalogId: "test-catalog-id",
    } as McpServer;

    const k8sDeployment = new K8sDeployment(
      mockMcpServer,
      {} as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );

    expect(k8sDeployment.k8sDeploymentName).toBe("mcp-my-mcp-server");
  });
});

describe("fetchPlatformPodNodeSelector", () => {
  // Reset cache before each test
  test.beforeEach(() => {
    resetPlatformNodeSelectorCache();
  });

  test("returns nodeSelector from pod when POD_NAME env var is set", async () => {
    // Save and set POD_NAME env var
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-abc123";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        nodeSelector: {
          "karpenter.sh/nodepool": "general-purpose",
          "kubernetes.io/os": "linux",
        },
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "default");

    expect(result).toEqual({
      "karpenter.sh/nodepool": "general-purpose",
      "kubernetes.io/os": "linux",
    });

    expect(mockReadPod).toHaveBeenCalledWith({
      name: "archestra-platform-abc123",
      namespace: "default",
    });

    // Restore env var
    process.env.POD_NAME = originalPodName;
  });

  test("ignores HOSTNAME when not running in-cluster (only uses POD_NAME)", async () => {
    // When running outside K8s (Docker mode, local dev), HOSTNAME is the container ID
    // which doesn't correspond to a K8s pod. Only POD_NAME should be used.
    const originalConfig =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;
    const originalPodName = process.env.POD_NAME;
    const originalHostname = process.env.HOSTNAME;

    try {
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = false;
      delete process.env.POD_NAME;
      process.env.HOSTNAME = "b960428dea4c"; // Docker container ID

      const mockListPods = vi.fn().mockResolvedValue({
        items: [], // No pods found via label selector
      });

      const mockK8sApi = {
        listNamespacedPod: mockListPods,
      } as unknown as k8s.CoreV1Api;

      const result = await fetchPlatformPodNodeSelector(mockK8sApi, "test-ns");

      // Should fall back to label selector (not try to read pod by HOSTNAME)
      expect(result).toBeNull();
      expect(mockListPods).toHaveBeenCalledWith({
        namespace: "test-ns",
        labelSelector: "app.kubernetes.io/name=archestra-platform",
      });
    } finally {
      process.env.POD_NAME = originalPodName;
      process.env.HOSTNAME = originalHostname;
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
        originalConfig;
    }
  });

  test("uses HOSTNAME as fallback when running in-cluster", async () => {
    // When running inside K8s cluster, HOSTNAME is the pod name
    const originalConfig =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;
    const originalPodName = process.env.POD_NAME;
    const originalHostname = process.env.HOSTNAME;

    try {
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = true;
      delete process.env.POD_NAME;
      process.env.HOSTNAME = "archestra-platform-xyz789";

      const mockReadPod = vi.fn().mockResolvedValue({
        spec: {
          nodeSelector: {
            "node.kubernetes.io/instance-type": "m5.large",
          },
        },
      });

      const mockK8sApi = {
        readNamespacedPod: mockReadPod,
      } as unknown as k8s.CoreV1Api;

      const result = await fetchPlatformPodNodeSelector(mockK8sApi, "test-ns");

      expect(result).toEqual({
        "node.kubernetes.io/instance-type": "m5.large",
      });
      expect(mockReadPod).toHaveBeenCalledWith({
        name: "archestra-platform-xyz789",
        namespace: "test-ns",
      });
    } finally {
      process.env.POD_NAME = originalPodName;
      process.env.HOSTNAME = originalHostname;
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
        originalConfig;
    }
  });

  test("returns null when pod has no nodeSelector", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-no-selector";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        containers: [{ name: "archestra" }],
        // No nodeSelector
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "default");

    expect(result).toBeNull();

    process.env.POD_NAME = originalPodName;
  });

  test("falls back to label selector when POD_NAME/HOSTNAME not set", async () => {
    const originalPodName = process.env.POD_NAME;
    const originalHostname = process.env.HOSTNAME;
    delete process.env.POD_NAME;
    delete process.env.HOSTNAME;

    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "archestra-platform-abc" },
          status: { phase: "Running" },
          spec: {
            nodeSelector: {
              "karpenter.sh/nodepool": "platform-pool",
            },
          },
        },
      ],
    });

    const mockK8sApi = {
      listNamespacedPod: mockListPods,
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "archestra");

    expect(result).toEqual({
      "karpenter.sh/nodepool": "platform-pool",
    });

    expect(mockListPods).toHaveBeenCalledWith({
      namespace: "archestra",
      labelSelector: "app.kubernetes.io/name=archestra-platform",
    });

    process.env.POD_NAME = originalPodName;
    process.env.HOSTNAME = originalHostname;
  });

  test("returns null when no platform pods found via label selector", async () => {
    const originalPodName = process.env.POD_NAME;
    const originalHostname = process.env.HOSTNAME;
    delete process.env.POD_NAME;
    delete process.env.HOSTNAME;

    const mockListPods = vi.fn().mockResolvedValue({
      items: [],
    });

    const mockK8sApi = {
      listNamespacedPod: mockListPods,
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "default");

    expect(result).toBeNull();

    process.env.POD_NAME = originalPodName;
    process.env.HOSTNAME = originalHostname;
  });

  test("caches result after first call", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-cached";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        nodeSelector: {
          cached: "value",
        },
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    // First call
    const result1 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result1).toEqual({ cached: "value" });
    expect(mockReadPod).toHaveBeenCalledTimes(1);

    // Second call should return cached value without API call
    const result2 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result2).toEqual({ cached: "value" });
    expect(mockReadPod).toHaveBeenCalledTimes(1); // Still only called once

    process.env.POD_NAME = originalPodName;
  });

  test("returns null and caches on API error", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-error";

    const mockReadPod = vi
      .fn()
      .mockRejectedValue(new Error("API connection failed"));

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "default");

    expect(result).toBeNull();

    // Subsequent calls should return cached null without API call
    const result2 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result2).toBeNull();
    expect(mockReadPod).toHaveBeenCalledTimes(1);

    process.env.POD_NAME = originalPodName;
  });
});

describe("getCachedPlatformNodeSelector", () => {
  // Reset cache before each test to ensure isolation
  test.beforeEach(() => {
    resetPlatformNodeSelectorCache();
  });

  test("returns null before any fetch", () => {
    expect(getCachedPlatformNodeSelector()).toBeNull();
  });

  test("returns cached value after fetch", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "test-pod";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        nodeSelector: {
          "test-key": "test-value",
        },
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    await fetchPlatformPodNodeSelector(mockK8sApi, "default");

    expect(getCachedPlatformNodeSelector()).toEqual({
      "test-key": "test-value",
    });

    process.env.POD_NAME = originalPodName;
  });
});

describe("resetPlatformNodeSelectorCache", () => {
  // Reset cache before each test to ensure isolation
  test.beforeEach(() => {
    resetPlatformNodeSelectorCache();
  });

  test("clears the cached nodeSelector", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "test-pod";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        nodeSelector: {
          "before-reset": "value",
        },
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(getCachedPlatformNodeSelector()).toEqual({
      "before-reset": "value",
    });

    resetPlatformNodeSelectorCache();

    expect(getCachedPlatformNodeSelector()).toBeNull();

    process.env.POD_NAME = originalPodName;
  });
});

describe("K8sDeployment.getRecentLogs", () => {
  function createK8sDeploymentWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
  ): K8sDeployment {
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

    return new K8sDeployment(
      mockMcpServer,
      mockK8sApi as k8s.CoreV1Api,
      {} as k8s.AppsV1Api,
      {} as Attach,
      {} as Log,
      "default",
      null,
      undefined,
      undefined,
    );
  }

  test("returns 'Pod not found or not running' when no pod exists", async () => {
    const mockListPods = vi.fn().mockResolvedValue({ items: [] });
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    const logs = await k8sDeployment.getRecentLogs();

    expect(logs).toBe("Pod not found or not running");
  });

  test("returns 'Pod not found or not running' when pod is not in Running phase", async () => {
    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "test-pod" },
          status: { phase: "Pending" },
        },
      ],
    });
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    const logs = await k8sDeployment.getRecentLogs();

    expect(logs).toBe("Pod not found or not running");
  });

  test("returns logs from running pod", async () => {
    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "test-pod-abc123" },
          status: { phase: "Running" },
        },
      ],
    });
    const mockReadLogs = vi.fn().mockResolvedValue("Log line 1\nLog line 2\n");
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
      readNamespacedPodLog: mockReadLogs,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    const logs = await k8sDeployment.getRecentLogs(50);

    expect(logs).toBe("Log line 1\nLog line 2\n");
    expect(mockReadLogs).toHaveBeenCalledWith({
      name: "test-pod-abc123",
      namespace: "default",
      tailLines: 50,
    });
  });

  test("returns 'Pod not found' when readNamespacedPodLog returns 404 (statusCode)", async () => {
    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "test-pod-abc123" },
          status: { phase: "Running" },
        },
      ],
    });
    const notFoundError = { statusCode: 404, message: "Pod not found" };
    const mockReadLogs = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
      readNamespacedPodLog: mockReadLogs,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    const logs = await k8sDeployment.getRecentLogs();

    expect(logs).toBe("Pod not found");
  });

  test("returns 'Pod not found' when readNamespacedPodLog returns 404 (code)", async () => {
    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "test-pod-abc123" },
          status: { phase: "Running" },
        },
      ],
    });
    const notFoundError = { code: 404, message: "Pod not found" };
    const mockReadLogs = vi.fn().mockRejectedValue(notFoundError);
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
      readNamespacedPodLog: mockReadLogs,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    const logs = await k8sDeployment.getRecentLogs();

    expect(logs).toBe("Pod not found");
  });

  test("throws error for non-404 errors", async () => {
    const mockListPods = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "test-pod-abc123" },
          status: { phase: "Running" },
        },
      ],
    });
    const serverError = { statusCode: 500, message: "Internal server error" };
    const mockReadLogs = vi.fn().mockRejectedValue(serverError);
    const mockK8sApi = {
      listNamespacedPod: mockListPods,
      readNamespacedPodLog: mockReadLogs,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);

    await expect(k8sDeployment.getRecentLogs()).rejects.toEqual(serverError);
  });
});

describe("K8sDeployment.sanitizeLabelValue", () => {
  test.each([
    // Basic sanitization
    ["My Server", "my-server"],
    ["TEST-VALUE", "test-value"],

    // Special characters
    ["value@123", "value123"],
    ["hello_world", "helloworld"],

    // Truncation to 63 characters
    ["a".repeat(100), "a".repeat(63)],

    // Trailing non-alphanumeric removal
    ["value-", "value"],
    ["value.", "value"],
    ["value--", "value"],

    // UUID-like values (common for server IDs)
    [
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000",
    ],

    // Emojis and unicode
    ["Server 🔥", "server"],
    ["Servér", "servr"],
  ])("sanitizes '%s' to '%s'", (input, expected) => {
    const result = K8sDeployment.sanitizeLabelValue(input);
    expect(result).toBe(expected);

    // Verify result is valid K8s label value (max 63 chars, alphanumeric + hyphen/dot)
    expect(result.length).toBeLessThanOrEqual(63);
    if (result.length > 0) {
      expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    }
  });
});
