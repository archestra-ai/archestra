import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import type { LocalConfigSchema } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import type { Attach, Exec, Log } from "@kubernetes/client-node";
import { vi } from "vitest";
import type { z } from "zod";
import config from "@/config";
import { describe, expect, test } from "@/test";
import type { EffectiveNetworkPolicy, McpServer } from "@/types";
import K8sDeployment, {
  fetchPlatformPodNodeSelector,
  fetchPlatformPodTolerations,
  getCachedPlatformNodeSelector,
  resetPlatformNodeSelectorCache,
  resetPlatformTolerationsCache,
} from "./k8s-deployment";
import { buildEgressBaselineNetworkPolicy } from "./network-policy";

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
  const mockK8sNetworkingApi = {} as k8s.NetworkingV1Api;
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

  return new K8sDeployment({
    mcpServer: mockMcpServer,
    k8sApi: mockK8sApi,
    k8sAppsApi: mockK8sAppsApi,
    k8sNetworkingApi: mockK8sNetworkingApi,
    k8sAttach: mockK8sAttach,
    k8sLog: mockK8sLog,
    k8sExec: {} as Exec,
    namespace: "default",
    catalogItem: null,
    userConfigValues,
    environmentValues: stringEnvironmentValues,
  });
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

    return new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: mockK8sApi,
      k8sAppsApi: mockK8sAppsApi,
      k8sAttach: mockK8sAttach,
      k8sLog: mockK8sLog,
      k8sExec: {} as Exec,
      namespace: namespace,
      catalogItem: null,
      userConfigValues,
      environmentValues,
    });
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
    expect(container?.imagePullPolicy).toBe("Never");
    expect(container?.command).toEqual(["node"]);
    expect(container?.args).toEqual(["server.js"]);
    expect(container?.stdin).toBe(true);
    expect(container?.tty).toBe(false);
    expect(container?.ports).toBeUndefined();
    expect(templateSpec?.enableServiceLinks).toBe(false);
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
    const k8sDeployment = new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: mockK8sApi,
      k8sAppsApi: mockK8sAppsApi,
      k8sAttach: mockK8sAttach,
      k8sLog: mockK8sLog,
      k8sExec: {} as Exec,
      namespace: "default",
      environmentValues: environmentValues,
    });

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
    expect(container?.imagePullPolicy).toBe("Always");
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
    const k8sDeployment = new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: mockK8sApi,
      k8sAppsApi: mockK8sAppsApi,
      k8sAttach: mockK8sAttach,
      k8sLog: mockK8sLog,
      k8sExec: {} as Exec,
      namespace: "default",
      environmentValues: environmentValues,
    });

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

  test("generates deploymentSpec with tolerations when provided", () => {
    const mcpServer: McpServer = {
      id: "toleration-test-id",
      name: "toleration-server",
      catalogId: "catalog-tol",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const tolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "mcp-servers",
        effect: "NoSchedule",
      },
    ];

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      undefined,
      tolerations,
    );

    expect(deploymentSpec.spec?.template.spec?.tolerations).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "mcp-servers",
        effect: "NoSchedule",
      },
    ]);
  });

  test("generates deploymentSpec with multiple tolerations", () => {
    const mcpServer: McpServer = {
      id: "multi-tol-test-id",
      name: "multi-toleration-server",
      catalogId: "catalog-multi-tol",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const tolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "mcp-servers",
        effect: "NoSchedule",
      },
      {
        key: "gpu",
        operator: "Exists",
        effect: "NoExecute",
        tolerationSeconds: 3600,
      },
    ];

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      undefined,
      tolerations,
    );

    expect(deploymentSpec.spec?.template.spec?.tolerations).toHaveLength(2);
    expect(deploymentSpec.spec?.template.spec?.tolerations).toEqual(
      tolerations,
    );
  });

  test("generates deploymentSpec without tolerations when null is provided", () => {
    const mcpServer: McpServer = {
      id: "no-tol-id",
      name: "no-toleration-server",
      catalogId: "catalog-no-tol",
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
      null,
    );

    expect(deploymentSpec.spec?.template.spec?.tolerations).toBeUndefined();
  });

  test("generates deploymentSpec without tolerations when undefined is provided", () => {
    const mcpServer: McpServer = {
      id: "undef-tol-id",
      name: "undef-toleration-server",
      catalogId: "catalog-undef-tol",
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
      undefined,
    );

    expect(deploymentSpec.spec?.template.spec?.tolerations).toBeUndefined();
  });

  test("generates deploymentSpec without tolerations when empty array is provided", () => {
    const mcpServer: McpServer = {
      id: "empty-tol-id",
      name: "empty-toleration-server",
      catalogId: "catalog-empty-tol",
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
      [],
    );

    expect(deploymentSpec.spec?.template.spec?.tolerations).toBeUndefined();
  });

  test("combines tolerations with nodeSelector when both are configured", () => {
    const mcpServer: McpServer = {
      id: "combined-tol-ns-id",
      name: "combined-tol-ns-server",
      catalogId: "catalog-combined-tol-ns",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
    };
    const nodeSelector = {
      "karpenter.sh/nodepool": "mcp-pool",
    };
    const tolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "mcp-servers",
        effect: "NoSchedule",
      },
    ];

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      nodeSelector,
      tolerations,
    );

    expect(deploymentSpec.spec?.template.spec?.nodeSelector).toEqual({
      "karpenter.sh/nodepool": "mcp-pool",
    });
    expect(deploymentSpec.spec?.template.spec?.tolerations).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "mcp-servers",
        effect: "NoSchedule",
      },
    ]);
  });

  test("generates deploymentSpec with imagePullSecrets when provided", () => {
    const mcpServer: McpServer = {
      id: "ips-test-id",
      name: "ips-test-server",
      catalogId: "catalog-ips",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "private-registry.example.com/mcp-server:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      imagePullSecrets: [{ source: "existing", name: "my-registry-secret" }],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      undefined,
      undefined,
      [{ name: "my-registry-secret" }],
    );

    expect(deploymentSpec.spec?.template.spec?.imagePullSecrets).toEqual([
      { name: "my-registry-secret" },
    ]);
  });

  test("generates deploymentSpec with multiple imagePullSecrets", () => {
    const mcpServer: McpServer = {
      id: "multi-ips-test-id",
      name: "multi-ips-test-server",
      catalogId: "catalog-multi-ips",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "private-registry.example.com/mcp-server:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      imagePullSecrets: [
        { source: "existing", name: "registry-secret-1" },
        { source: "existing", name: "registry-secret-2" },
      ],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
      undefined,
      undefined,
      [{ name: "registry-secret-1" }, { name: "registry-secret-2" }],
    );

    expect(deploymentSpec.spec?.template.spec?.imagePullSecrets).toEqual([
      { name: "registry-secret-1" },
      { name: "registry-secret-2" },
    ]);
  });

  test("generates deploymentSpec without imagePullSecrets when not provided", () => {
    const mcpServer: McpServer = {
      id: "no-ips-test-id",
      name: "no-ips-test-server",
      catalogId: "catalog-no-ips",
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
    );

    expect(
      deploymentSpec.spec?.template.spec?.imagePullSecrets,
    ).toBeUndefined();
  });

  test("generates deploymentSpec without imagePullSecrets when empty array is provided", () => {
    const mcpServer: McpServer = {
      id: "empty-ips-test-id",
      name: "empty-ips-test-server",
      catalogId: "catalog-empty-ips",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      imagePullSecrets: [],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
    );

    expect(
      deploymentSpec.spec?.template.spec?.imagePullSecrets,
    ).toBeUndefined();
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

  test("generates deploymentSpec with envFrom referencing existing K8s Secret", () => {
    const mcpServer: McpServer = {
      id: "envfrom-secret-id",
      name: "envfrom-secret-server",
      catalogId: "catalog-envfrom",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      envFrom: [{ type: "secret", name: "github-app-token" }],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toEqual([
      { secretRef: { name: "github-app-token" } },
    ]);
  });

  test("generates deploymentSpec with envFrom referencing existing K8s ConfigMap", () => {
    const mcpServer: McpServer = {
      id: "envfrom-configmap-id",
      name: "envfrom-configmap-server",
      catalogId: "catalog-envfrom-cm",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      envFrom: [{ type: "configMap", name: "mcp-config" }],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toEqual([
      { configMapRef: { name: "mcp-config" } },
    ]);
  });

  test("generates deploymentSpec with envFrom including prefix", () => {
    const mcpServer: McpServer = {
      id: "envfrom-prefix-id",
      name: "envfrom-prefix-server",
      catalogId: "catalog-envfrom-prefix",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      envFrom: [
        { type: "secret", name: "github-token", prefix: "GH_" },
        { type: "configMap", name: "shared-config", prefix: "APP_" },
      ],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toEqual([
      { secretRef: { name: "github-token" }, prefix: "GH_" },
      { configMapRef: { name: "shared-config" }, prefix: "APP_" },
    ]);
  });

  test("does not include envFrom when envFrom array is empty", () => {
    const mcpServer: McpServer = {
      id: "no-envfrom-id",
      name: "no-envfrom-server",
      catalogId: "catalog-no-envfrom",
      // biome-ignore lint/suspicious/noExplicitAny: Mock data for testing
    } as any;

    const k8sDeployment = createMockK8sDeployment(mcpServer);

    const dockerImage = "test:latest";
    const localConfig: z.infer<typeof LocalConfigSchema> = {
      command: "node",
      arguments: ["server.js"],
      envFrom: [],
    };

    const deploymentSpec = k8sDeployment.generateDeploymentSpec(
      dockerImage,
      localConfig,
      false,
      8080,
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toBeUndefined();
  });

  test("does not include envFrom when not specified", () => {
    const mcpServer: McpServer = {
      id: "undefined-envfrom-id",
      name: "undefined-envfrom-server",
      catalogId: "catalog-undefined-envfrom",
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
    );

    const container = deploymentSpec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toBeUndefined();
  });
});

describe("K8sDeployment.generateDeploymentSpec - YAML + platform nodeSelector/tolerations", () => {
  const minimalYaml = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: test:latest
          command: ["node"]
          args: ["server.js"]
`;

  function createK8sDeploymentWithYaml(
    yamlString: string,
    yamlNodeSelector?: Record<string, string>,
    yamlTolerations?: Array<{
      key: string;
      operator: string;
      value?: string;
      effect: string;
    }>,
  ): K8sDeployment {
    // Build YAML with optional nodeSelector/tolerations baked in
    let yaml = yamlString;
    if (yamlNodeSelector || yamlTolerations) {
      const lines = yaml.split("\n");
      const specInsertIndex = lines.findIndex((l) => l.includes("containers:"));
      const insertions: string[] = [];
      if (yamlNodeSelector) {
        insertions.push("      nodeSelector:");
        for (const [k, v] of Object.entries(yamlNodeSelector)) {
          insertions.push(`        ${k}: "${v}"`);
        }
      }
      if (yamlTolerations) {
        insertions.push("      tolerations:");
        for (const tol of yamlTolerations) {
          insertions.push(`        - key: "${tol.key}"`);
          insertions.push(`          operator: "${tol.operator}"`);
          if (tol.value) {
            insertions.push(`          value: "${tol.value}"`);
          }
          insertions.push(`          effect: "${tol.effect}"`);
        }
      }
      lines.splice(specInsertIndex, 0, ...insertions);
      yaml = lines.join("\n");
    }

    const catalogItem = {
      deploymentSpecYaml: yaml,
      localConfig: { command: "node", arguments: ["server.js"] },
    } as unknown as import("@/types").InternalMcpCatalog;

    const mcpServer = {
      id: "yaml-test-id",
      name: "yaml-test-server",
      catalogId: "catalog-yaml",
    } as McpServer;

    return new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: catalogItem,
    });
  }

  test("applies platform nodeSelector when YAML has none", () => {
    const k8sDeployment = createK8sDeploymentWithYaml(minimalYaml);

    const platformNodeSelector = {
      "karpenter.sh/nodepool": "general-purpose",
    };

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
      platformNodeSelector,
      null,
    );

    expect(spec.spec?.template.spec?.nodeSelector).toEqual({
      "karpenter.sh/nodepool": "general-purpose",
    });
  });

  test("merges platform nodeSelector with YAML nodeSelector (platform wins on conflict)", () => {
    const k8sDeployment = createK8sDeploymentWithYaml(minimalYaml, {
      "user-key": "user-value",
      "karpenter.sh/nodepool": "user-pool",
    });

    const platformNodeSelector = {
      "karpenter.sh/nodepool": "platform-pool",
      "kubernetes.io/os": "linux",
    };

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
      platformNodeSelector,
      null,
    );

    expect(spec.spec?.template.spec?.nodeSelector).toEqual({
      "user-key": "user-value",
      "karpenter.sh/nodepool": "platform-pool",
      "kubernetes.io/os": "linux",
    });
  });

  test("applies platform tolerations when YAML has none", () => {
    const k8sDeployment = createK8sDeploymentWithYaml(minimalYaml);

    const platformTolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ];

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
      null,
      platformTolerations,
    );

    expect(spec.spec?.template.spec?.tolerations).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ]);
  });

  test("YAML tolerations override platform tolerations entirely", () => {
    const k8sDeployment = createK8sDeploymentWithYaml(minimalYaml, undefined, [
      { key: "custom", operator: "Exists", effect: "NoExecute" },
    ]);

    const platformTolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ];

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
      null,
      platformTolerations,
    );

    // YAML tolerations win — platform tolerations are NOT merged
    expect(spec.spec?.template.spec?.tolerations).toEqual([
      { key: "custom", operator: "Exists", effect: "NoExecute" },
    ]);
  });

  test("applies both platform nodeSelector and tolerations when YAML defines neither", () => {
    const k8sDeployment = createK8sDeploymentWithYaml(minimalYaml);

    const platformNodeSelector = { "karpenter.sh/nodepool": "platform-pool" };
    const platformTolerations: k8s.V1Toleration[] = [
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ];

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
      platformNodeSelector,
      platformTolerations,
    );

    expect(spec.spec?.template.spec?.nodeSelector).toEqual({
      "karpenter.sh/nodepool": "platform-pool",
    });
    expect(spec.spec?.template.spec?.tolerations).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ]);
  });

  test("preserves user-added envFrom entries in deployment YAML", () => {
    const yamlWithEnvFrom = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: test:latest
          command: ["node"]
          args: ["server.js"]
          envFrom:
            - secretRef:
                name: github-app-token
            - configMapRef:
                name: shared-config
              prefix: APP_
`;

    const k8sDeployment = createK8sDeploymentWithYaml(yamlWithEnvFrom);

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
    );

    const container = spec.spec?.template.spec?.containers[0];
    expect(container?.envFrom).toEqual([
      { secretRef: { name: "github-app-token" } },
      { configMapRef: { name: "shared-config" }, prefix: "APP_" },
    ]);
  });

  test("preserves user-added secretKeyRef entries referencing external secrets in YAML", () => {
    const yamlWithExternalSecret = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: test:latest
          command: ["node"]
          args: ["server.js"]
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: github-app-external-secret
                  key: token
            - name: CUSTOM_VAR
              value: "my-value"
`;

    const k8sDeployment = createK8sDeploymentWithYaml(yamlWithExternalSecret);

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
    );

    const container = spec.spec?.template.spec?.containers[0];
    const githubToken = container?.env?.find((e) => e.name === "GITHUB_TOKEN");
    const customVar = container?.env?.find((e) => e.name === "CUSTOM_VAR");

    // User-added secretKeyRef referencing external secret should be preserved
    expect(githubToken).toEqual({
      name: "GITHUB_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: "github-app-external-secret",
          key: "token",
        },
      },
    });

    // User-added plain env var should be preserved
    expect(customVar).toEqual({
      name: "CUSTOM_VAR",
      value: "my-value",
    });
  });

  test("filters archestra-managed secretKeyRef for empty secrets but preserves external ones", () => {
    // YAML contains both an archestra-managed secretKeyRef and a user-added external one
    const yamlWithMixedSecrets = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: test:latest
          command: ["node"]
          args: ["server.js"]
          env:
            - name: ARCHESTRA_SECRET
              valueFrom:
                secretKeyRef:
                  name: mcp-server-yaml-test-id-secrets
                  key: ARCHESTRA_SECRET
            - name: EXTERNAL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: my-external-secret
                  key: api-token
`;

    const k8sDeployment = createK8sDeploymentWithYaml(yamlWithMixedSecrets);

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      { command: "node", arguments: ["server.js"] },
      false,
      8080,
    );

    const container = spec.spec?.template.spec?.containers[0];

    // Archestra-managed secretKeyRef should be filtered out (no corresponding secret value)
    const archestraSecret = container?.env?.find(
      (e) => e.name === "ARCHESTRA_SECRET",
    );
    expect(archestraSecret).toBeUndefined();

    // External secretKeyRef should be preserved
    const externalToken = container?.env?.find(
      (e) => e.name === "EXTERNAL_TOKEN",
    );
    expect(externalToken).toEqual({
      name: "EXTERNAL_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: "my-external-secret",
          key: "api-token",
        },
      },
    });
  });

  test("merges localConfig.envFrom with YAML envFrom without duplicates", () => {
    const yamlWithEnvFrom = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: test:latest
          command: ["node"]
          args: ["server.js"]
          envFrom:
            - secretRef:
                name: existing-yaml-secret
`;

    const catalogItem = {
      deploymentSpecYaml: yamlWithEnvFrom,
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        envFrom: [
          { type: "secret" as const, name: "from-local-config" },
          { type: "secret" as const, name: "existing-yaml-secret" }, // duplicate
        ],
      },
    } as unknown as import("@/types").InternalMcpCatalog;

    const mcpServer = {
      id: "yaml-envfrom-merge-id",
      name: "yaml-envfrom-merge-server",
      catalogId: "catalog-yaml-envfrom",
    } as McpServer;

    const k8sDeployment = new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: catalogItem,
    });

    const spec = k8sDeployment.generateDeploymentSpec(
      "test:latest",
      {
        command: "node",
        arguments: ["server.js"],
        envFrom: [
          { type: "secret", name: "from-local-config" },
          { type: "secret", name: "existing-yaml-secret" }, // duplicate
        ],
      },
      false,
      8080,
    );

    const container = spec.spec?.template.spec?.containers[0];
    // Should have existing-yaml-secret from YAML + from-local-config from localConfig, no duplicates
    expect(container?.envFrom).toEqual([
      { secretRef: { name: "existing-yaml-secret" } },
      { secretRef: { name: "from-local-config" } },
    ]);
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      environmentValues: secretData,
    });
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

    const k8sDeployment = new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });

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

    const k8sDeployment = new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });

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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
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

describe("K8sDeployment.createServiceForHttpServer (selector reconciliation)", () => {
  function createK8sDeploymentWithMockedApi(
    mockK8sApi: Partial<k8s.CoreV1Api>,
  ): K8sDeployment {
    const mockMcpServer = {
      id: "new-server-id",
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  type PrivateCreateService = {
    createServiceForHttpServer: (
      httpPort: number,
      nodePort?: number,
    ) => Promise<void>;
  };

  // Regression: a service whose selector still targets a stale mcp-server-id
  // (left over after the server record was recreated with a new id) selects
  // zero pods and gets no endpoints, so every read/connect fails. An existing
  // service must be reconciled to the current id, not skipped.
  test("reconciles an existing service's selector to the current mcp-server-id", async () => {
    const mockRead = vi.fn().mockResolvedValue({}); // service already exists
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockCreate = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      readNamespacedService: mockRead,
      patchNamespacedService: mockPatch,
      createNamespacedService: mockCreate,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    await (
      k8sDeployment as unknown as PrivateCreateService
    ).createServiceForHttpServer(8080);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const patchArg = mockPatch.mock.calls[0][0] as {
      name: string;
      namespace: string;
      body: {
        metadata: { labels: Record<string, string> };
        spec: { selector: Record<string, string> };
      };
    };
    expect(patchArg.name).toBe("mcp-test-server-service");
    expect(patchArg.namespace).toBe("default");
    expect(patchArg.body.spec.selector["mcp-server-id"]).toBe("new-server-id");
    expect(patchArg.body.metadata.labels["mcp-server-id"]).toBe(
      "new-server-id",
    );
  });

  test("creates the service when it does not yet exist", async () => {
    const notFound = { statusCode: 404, message: "Service not found" };
    const mockRead = vi.fn().mockRejectedValue(notFound);
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockCreate = vi.fn().mockResolvedValue({});
    const mockK8sApi = {
      readNamespacedService: mockRead,
      patchNamespacedService: mockPatch,
      createNamespacedService: mockCreate,
    };

    const k8sDeployment = createK8sDeploymentWithMockedApi(mockK8sApi);
    await (
      k8sDeployment as unknown as PrivateCreateService
    ).createServiceForHttpServer(8080);

    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0] as {
      body: { spec: { selector: Record<string, string> } };
    };
    expect(createArg.body.spec.selector["mcp-server-id"]).toBe("new-server-id");
  });
});

describe("K8sDeployment multitenant selector stability", () => {
  function make(
    // biome-ignore lint/suspicious/noExplicitAny: minimal catalog mock for tests
    catalogItem: any,
  ): K8sDeployment {
    const mcpServer = {
      id: "install-abc-123",
      name: "archestra-pm",
      catalogId: "cat9999-0000-0000-0000-000000000000",
      // biome-ignore lint/suspicious/noExplicitAny: mock server for tests
    } as any as McpServer;
    return new K8sDeployment({
      mcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem,
    });
  }
  const localConfig: z.infer<typeof LocalConfigSchema> = {
    command: "node",
    arguments: ["server.js"],
  };

  // Multitenant catalogs share ONE catalog-named Deployment + Service across all
  // installs. If the selector used the per-install id, two installs would fight
  // over the shared resource and leave the Service with zero endpoints. The
  // selector must be catalog-stable so every install reconciles to the same one.
  test("multitenant: deployment selector + pod labels use the catalog id (not the per-install id)", () => {
    const catalogItem = { multitenant: true, name: "Archestra PM" };
    const spec = make(catalogItem).generateDeploymentSpec(
      "img:latest",
      localConfig,
      true,
      8080,
    );
    expect(spec.spec?.selector.matchLabels?.["mcp-server-id"]).toBe(
      "cat9999-0000-0000-0000-000000000000",
    );
    expect(spec.spec?.template.metadata?.labels?.["mcp-server-id"]).toBe(
      "cat9999-0000-0000-0000-000000000000",
    );
    // The name is catalog-derived too, so name and selector stay in lockstep.
    expect(spec.metadata?.name).toContain("mcp-mt-cat9999-");
  });

  test("single-tenant (no catalog item): selector keeps the per-install id", () => {
    const spec = make(null).generateDeploymentSpec(
      "img:latest",
      localConfig,
      true,
      8080,
    );
    expect(spec.spec?.selector.matchLabels?.["mcp-server-id"]).toBe(
      "install-abc-123",
    );
  });
});

describe("K8sDeployment.constructHttpServiceName", () => {
  function createK8sDeploymentForServiceName(
    serverName: string,
  ): K8sDeployment {
    const mockMcpServer = {
      id: "test-server-id",
      name: serverName,
      catalogId: "test-catalog-id",
      secretId: null,
      ownerId: null,
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  test("generates service name within 63-character K8s limit for short names", () => {
    const k8sDeployment = createK8sDeploymentForServiceName("test-server");
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    expect(serviceName).toBe("mcp-test-server-service");
    expect(serviceName.length).toBeLessThanOrEqual(63);
  });

  test("truncates long MCP server names to fit within 63-character limit (issue #2613)", () => {
    // Reproduce the exact scenario from issue #2613:
    // MCP name "flux159mcp-server-kubernetes" with a team/user ID suffix
    const k8sDeployment = createK8sDeploymentForServiceName(
      "flux159mcp-server-kubernetes-bna5abjosg7kzhigeqis4yxwlwkeervo",
    );
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    expect(serviceName.length).toBeLessThanOrEqual(63);
    expect(serviceName).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?-service$/);
  });

  test("handles very long names by truncating base before appending suffix", () => {
    const longName = "a".repeat(200);
    const k8sDeployment = createK8sDeploymentForServiceName(longName);
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    expect(serviceName.length).toBeLessThanOrEqual(63);
    expect(serviceName).toMatch(/-service$/);
  });

  test("strips trailing hyphens after truncation", () => {
    // Craft a name that when prefixed with "mcp-" and truncated to 55 chars, ends with a hyphen
    // "mcp-" = 4 chars, so we need 51 chars + hyphen at position 55
    const nameBase = `${"a".repeat(50)}-${"b".repeat(10)}`;
    const k8sDeployment = createK8sDeploymentForServiceName(nameBase);
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    expect(serviceName.length).toBeLessThanOrEqual(63);
    expect(serviceName).not.toMatch(/-{2}/);
    expect(serviceName).toMatch(/^[a-z0-9]/);
    expect(serviceName).toMatch(/[a-z0-9]$/);
  });

  test("replaces dots with hyphens in deployment name", () => {
    const k8sDeployment = createK8sDeploymentForServiceName("server.v2.0");
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    expect(serviceName).toBe("mcp-server-v2-0-service");
    expect(serviceName).not.toContain(".");
  });

  test("handles names that produce only 'mcp' prefix after sanitization", () => {
    const k8sDeployment = createK8sDeploymentForServiceName("@@@");
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const serviceName = (k8sDeployment as any).constructHttpServiceName();

    // "@@@" is sanitized away, leaving deployment name "mcp-"
    // After trailing hyphen removal, base becomes "mcp"
    expect(serviceName).toBe("mcp-service");
    expect(serviceName.length).toBeLessThanOrEqual(63);
    expect(serviceName).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  test("produces consistent results for the same input", () => {
    const k8sDeployment = createK8sDeploymentForServiceName(
      "flux159mcp-server-kubernetes-bna5abjosg7kzhigeqis4yxwlwkeervo",
    );
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const result1 = (k8sDeployment as any).constructHttpServiceName();
    // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
    const result2 = (k8sDeployment as any).constructHttpServiceName();

    expect(result1).toBe(result2);
  });

  test("all generated service names are valid K8s DNS labels", () => {
    const testNames = [
      "short",
      "a".repeat(100),
      "name-with-dots.v1.0",
      "UPPERCASE-NAME",
      "name with spaces",
      "flux159mcp-server-kubernetes-bna5abjosg7kzhigeqis4yxwlwkeervo",
      "special@chars!here",
    ];

    for (const name of testNames) {
      const k8sDeployment = createK8sDeploymentForServiceName(name);
      // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
      const serviceName = (k8sDeployment as any).constructHttpServiceName();

      expect(serviceName.length).toBeLessThanOrEqual(63);
      expect(serviceName).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("K8sDeployment.stopDeployment", () => {
  function createK8sDeploymentWithMockedApis(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    mockK8sAppsApi: Partial<k8s.AppsV1Api>,
    mockK8sNetworkingApi: Partial<k8s.NetworkingV1Api> = {
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    },
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: mockK8sAppsApi as k8s.AppsV1Api,
      k8sNetworkingApi: mockK8sNetworkingApi as k8s.NetworkingV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
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

describe("K8sDeployment.applyK8sNetworkPolicy", () => {
  type CustomPolicyObject = {
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
      finalizers?: string[];
    };
    spec?: Record<string, unknown>;
  };

  function makeNetworkPolicyTestServer(): McpServer {
    return {
      id: "test-server-id",
      name: "mcp-test-server",
      catalogId: "test-catalog-id",
      secretId: null,
      ownerId: null,
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;
  }

  function makeNetworkPolicy(
    overrides: Partial<NonNullable<EffectiveNetworkPolicy["policy"]>> = {},
  ): EffectiveNetworkPolicy {
    return {
      source: "environment",
      policy: {
        egressMode: "restricted",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
        ...overrides,
      },
    };
  }

  function makeNetworkPolicyDeployment(params: {
    networkingApi?: Partial<k8s.NetworkingV1Api>;
    customObjectsApi?: Partial<k8s.CustomObjectsApi>;
    coreApi?: Partial<k8s.CoreV1Api>;
    effectiveNetworkPolicy: EffectiveNetworkPolicy;
    networkPolicyCapabilities: {
      kubernetesNetworkPolicy: boolean;
      ciliumNetworkPolicy: boolean;
      gkeFqdnNetworkPolicy: boolean;
      awsApplicationNetworkPolicy: boolean;
      provider:
        | "kubernetes"
        | "cilium"
        | "gke-fqdn"
        | "aws-application-network-policy";
      supportsFqdn: boolean;
      supportsHttpMethods: boolean;
      message: string | null;
    };
    multitenant?: boolean;
  }): K8sDeployment {
    return new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: (params.coreApi ?? {}) as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: params.networkingApi as k8s.NetworkingV1Api,
      k8sCustomObjectsApi: params.customObjectsApi as k8s.CustomObjectsApi,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: params.multitenant
        ? ({
            multitenant: true,
            name: "test-catalog",
          } as unknown as import("@/types").InternalMcpCatalog)
        : null,
      effectiveNetworkPolicy: params.effectiveNetworkPolicy,
      networkPolicyCapabilities: params.networkPolicyCapabilities,
    });
  }

  function makeStatefulNetworkingApi(
    initialPolicies: k8s.V1NetworkPolicy[] = [],
  ): {
    api: Partial<k8s.NetworkingV1Api>;
    policies: Map<string, k8s.V1NetworkPolicy>;
  } {
    const policies = new Map(
      initialPolicies.map((policy) => [policy.metadata?.name ?? "", policy]),
    );

    const api = {
      createNamespacedNetworkPolicy: vi.fn(
        async ({ body }: { body: k8s.V1NetworkPolicy }) => {
          const name = body.metadata?.name;
          if (!name) throw new Error("NetworkPolicy name is required");
          if (policies.has(name)) throw { statusCode: 409 };
          policies.set(name, structuredClone(body));
          return {};
        },
      ),
      replaceNamespacedNetworkPolicy: vi.fn(
        async ({ name, body }: { name: string; body: k8s.V1NetworkPolicy }) => {
          if (!policies.has(name)) throw { statusCode: 404 };
          policies.set(name, structuredClone(body));
          return {};
        },
      ),
      listNamespacedNetworkPolicy: vi.fn(
        async ({ labelSelector }: { labelSelector?: string }) => ({
          items: [...policies.values()].filter((policy) =>
            hasLabels(policy.metadata?.labels, labelSelector),
          ),
        }),
      ),
      deleteNamespacedNetworkPolicy: vi.fn(
        async ({ name }: { name: string }) => {
          if (!policies.delete(name)) throw { statusCode: 404 };
          return {};
        },
      ),
    };

    return { api, policies };
  }

  function makeStatefulCustomObjectsApi(params: {
    resource: {
      group: string;
      version: string;
      plural: string;
    };
    initialPolicies?: CustomPolicyObject[];
  }): {
    api: Partial<k8s.CustomObjectsApi>;
    policies: Map<string, CustomPolicyObject>;
  } {
    const policies = new Map(
      (params.initialPolicies ?? []).map((policy) => [
        policy.metadata?.name ?? "",
        policy,
      ]),
    );

    const api = {
      createNamespacedCustomObject: vi.fn(
        async ({ body }: { body: CustomPolicyObject }) => {
          const name = body.metadata?.name;
          if (!name) throw new Error("Custom policy name is required");
          if (policies.has(name)) throw { statusCode: 409 };
          policies.set(name, structuredClone(body));
          return {};
        },
      ),
      patchNamespacedCustomObject: vi.fn(
        async ({ name, body }: { name: string; body: CustomPolicyObject }) => {
          const existing = policies.get(name);
          if (!existing) throw { statusCode: 404 };
          policies.set(
            name,
            applyJsonMergePatch(existing, body) as CustomPolicyObject,
          );
          return {};
        },
      ),
      listNamespacedCustomObject: vi.fn(
        async ({
          group,
          version,
          plural,
          labelSelector,
        }: {
          group: string;
          version: string;
          plural: string;
          labelSelector?: string;
        }) => {
          if (
            group !== params.resource.group ||
            version !== params.resource.version ||
            plural !== params.resource.plural
          ) {
            return { items: [] };
          }

          return {
            items: [...policies.values()].filter((policy) =>
              hasLabels(policy.metadata?.labels, labelSelector),
            ),
          };
        },
      ),
      deleteNamespacedCustomObject: vi.fn(
        async ({
          group,
          version,
          plural,
          name,
        }: {
          group: string;
          version: string;
          plural: string;
          name: string;
        }) => {
          if (
            group !== params.resource.group ||
            version !== params.resource.version ||
            plural !== params.resource.plural
          ) {
            throw { statusCode: 404 };
          }
          if (!policies.delete(name)) throw { statusCode: 404 };
          return {};
        },
      ),
    };

    return { api, policies };
  }

  /** RFC 7386 JSON merge patch: objects merge recursively, everything else replaces. */
  function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
    if (
      patch === null ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      target === null ||
      typeof target !== "object" ||
      Array.isArray(target)
    ) {
      return structuredClone(patch);
    }
    const result: Record<string, unknown> = {
      ...(target as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete result[key];
      } else {
        result[key] = applyJsonMergePatch(result[key], value);
      }
    }
    return result;
  }

  function hasLabels(
    labels: Record<string, string> | undefined,
    selector: string | undefined,
  ): boolean {
    if (!selector) return true;
    if (!labels) return false;
    return selector.split(",").every((part) => {
      const [key, value] = part.split("=");
      return labels[key] === value;
    });
  }

  test("creates CiliumNetworkPolicy and removes Kubernetes NetworkPolicy when FQDN rules are available", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const deleteNamespacedCustomObject = vi
      .fn()
      .mockRejectedValue({ statusCode: 404 });
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    const deleteNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});

    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: {
        createNamespacedNetworkPolicy,
        deleteNamespacedNetworkPolicy,
      } as unknown as k8s.NetworkingV1Api,
      k8sCustomObjectsApi: {
        createNamespacedCustomObject,
        deleteNamespacedCustomObject,
      } as unknown as k8s.CustomObjectsApi,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: true,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "cilium",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await deployment.applyK8sNetworkPolicy();

    expect(createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "cilium.io",
        version: "v2",
        namespace: "default",
        plural: "ciliumnetworkpolicies",
      }),
    );
    expect(createNamespacedNetworkPolicy).not.toHaveBeenCalled();
    expect(deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "mcp-egress-mcp-mcp-test-server",
      namespace: "default",
    });
  });

  test("creates Kubernetes NetworkPolicy for CIDR-only restricted policies", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const deleteNamespacedCustomObject = vi
      .fn()
      .mockRejectedValue({ statusCode: 404 });
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});

    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: {
        createNamespacedNetworkPolicy,
        deleteNamespacedNetworkPolicy: vi.fn().mockRejectedValue({
          statusCode: 404,
        }),
      } as unknown as k8s.NetworkingV1Api,
      k8sCustomObjectsApi: {
        createNamespacedCustomObject,
        deleteNamespacedCustomObject,
      } as unknown as k8s.CustomObjectsApi,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: false,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "kubernetes",
        supportsFqdn: false,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await deployment.applyK8sNetworkPolicy();

    expect(createNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "default",
        body: expect.objectContaining({
          kind: "NetworkPolicy",
        }),
      }),
    );
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  test("throws a clear error when applying without the K8s networking API", async () => {
    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: false,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "kubernetes",
        supportsFqdn: false,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await expect(deployment.applyK8sNetworkPolicy()).rejects.toThrow(
      "Cannot apply network policy: K8s networking API not available",
    );
  });

  test("throws a clear error when applying FQDN policy without the K8s custom objects API", async () => {
    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: {
        createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
        deleteNamespacedNetworkPolicy: vi.fn().mockRejectedValue({
          statusCode: 404,
        }),
      } as unknown as k8s.NetworkingV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: true,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "cilium",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await expect(deployment.applyK8sNetworkPolicy()).rejects.toThrow(
      "Cannot apply network policy: K8s custom objects API not available",
    );
  });

  test("creates GKE FQDNNetworkPolicy alongside Kubernetes NetworkPolicy when GKE FQDN rules are available", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const deleteNamespacedCustomObject = vi
      .fn()
      .mockRejectedValue({ statusCode: 404 });
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});

    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: {
        createNamespacedNetworkPolicy,
        deleteNamespacedNetworkPolicy: vi.fn().mockRejectedValue({
          statusCode: 404,
        }),
      } as unknown as k8s.NetworkingV1Api,
      k8sCustomObjectsApi: {
        createNamespacedCustomObject,
        deleteNamespacedCustomObject,
      } as unknown as k8s.CustomObjectsApi,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: false,
        gkeFqdnNetworkPolicy: true,
        awsApplicationNetworkPolicy: false,
        provider: "gke-fqdn",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await deployment.applyK8sNetworkPolicy();

    expect(createNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "default",
        body: expect.objectContaining({
          kind: "NetworkPolicy",
        }),
      }),
    );
    expect(createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "networking.gke.io",
        version: "v1alpha1",
        namespace: "default",
        plural: "fqdnnetworkpolicies",
      }),
    );
  });

  test("creates AWS ApplicationNetworkPolicy and removes Kubernetes NetworkPolicy when EKS Auto Mode FQDN rules are available", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const deleteNamespacedCustomObject = vi
      .fn()
      .mockRejectedValue({ statusCode: 404 });
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    const deleteNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});

    const deployment = new K8sDeployment({
      mcpServer: makeNetworkPolicyTestServer(),
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sNetworkingApi: {
        createNamespacedNetworkPolicy,
        deleteNamespacedNetworkPolicy,
      } as unknown as k8s.NetworkingV1Api,
      k8sCustomObjectsApi: {
        createNamespacedCustomObject,
        deleteNamespacedCustomObject,
      } as unknown as k8s.CustomObjectsApi,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: false,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: true,
        provider: "aws-application-network-policy",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: null,
      },
    });

    await deployment.applyK8sNetworkPolicy();

    expect(createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "networking.k8s.aws",
        version: "v1alpha1",
        namespace: "default",
        plural: "applicationnetworkpolicies",
        body: expect.objectContaining({
          kind: "ApplicationNetworkPolicy",
        }),
      }),
    );
    expect(createNamespacedNetworkPolicy).not.toHaveBeenCalled();
    expect(deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "mcp-egress-mcp-mcp-test-server",
      namespace: "default",
    });
  });

  test("updates an existing Kubernetes NetworkPolicy and cleans up stale duplicate managed policies", async () => {
    const policyName = "mcp-egress-mcp-mcp-test-server";
    const { api, policies } = makeStatefulNetworkingApi();
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes" as const,
      supportsFqdn: false,
      supportsHttpMethods: false,
      message: null,
    };

    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    const stalePolicy = structuredClone(policies.get(policyName));
    expect(stalePolicy).toBeDefined();
    if (!stalePolicy?.metadata) throw new Error("expected policy metadata");
    stalePolicy.metadata.name = "mcp-egress-generated-stale";
    policies.set(stalePolicy.metadata.name, stalePolicy);

    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["198.51.100.0/24"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([policyName]);
    expect(api.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(api.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "mcp-egress-generated-stale",
      namespace: "default",
    });
    expect(
      policies.get(policyName)?.metadata?.annotations?.[
        "archestra.io/network-policy-allowed-cidrs"
      ],
    ).toBe("198.51.100.0/24");
  });

  test("updates an existing AWS ApplicationNetworkPolicy in place and cleans up stale duplicate managed policies", async () => {
    const policyName = "mcp-egress-mcp-mcp-test-server";
    const { api: networkingApi } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies } = makeStatefulCustomObjectsApi({
      resource: {
        group: "networking.k8s.aws",
        version: "v1alpha1",
        plural: "applicationnetworkpolicies",
      },
    });
    const coreApi = {
      readNamespacedService: vi.fn(async () => ({
        spec: { clusterIP: "172.20.0.10", clusterIPs: ["172.20.0.10"] },
      })),
    };
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy" as const,
      supportsFqdn: true,
      supportsHttpMethods: false,
      message: null,
    };

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      coreApi: coreApi as unknown as Partial<k8s.CoreV1Api>,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    // Simulate a policy generated by an older release (no DNS bootstrap rule,
    // one domainNames entry per rule, plus a controller-owned finalizer).
    const existingPolicy = policies.get(policyName);
    expect(existingPolicy).toBeDefined();
    if (!existingPolicy?.metadata) throw new Error("expected policy metadata");
    existingPolicy.metadata.finalizers = ["networking.k8s.aws/anp-resources"];
    (existingPolicy as { spec?: Record<string, unknown> }).spec = {
      podSelector: existingPolicy.spec?.podSelector,
      policyTypes: ["Egress"],
      egress: [{ to: [{ domainNames: ["api.example.com"] }] }],
    };

    const stalePolicy = structuredClone(policies.get(policyName));
    expect(stalePolicy).toBeDefined();
    if (!stalePolicy?.metadata) throw new Error("expected policy metadata");
    stalePolicy.metadata.name = "mcp-egress-generated-stale";
    policies.set(stalePolicy.metadata.name, stalePolicy);

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      coreApi: coreApi as unknown as Partial<k8s.CoreV1Api>,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com", "cdn.example.com"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([policyName]);
    expect(customObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(
      1,
    );
    expect(customObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: "networking.k8s.aws",
      version: "v1alpha1",
      namespace: "default",
      plural: "applicationnetworkpolicies",
      name: "mcp-egress-generated-stale",
    });

    const updatedPolicy = policies.get(policyName);
    expect(updatedPolicy?.metadata?.annotations).toMatchObject({
      "archestra.io/network-policy-allowed-domains":
        "api.example.com,cdn.example.com",
      "archestra.io/network-policy-cluster-dns": "172.20.0.10",
    });
    // The improper egress rules are rewritten with the DNS bootstrap rule and
    // a single consolidated domainNames list, without touching the finalizer.
    expect(
      (updatedPolicy as { spec?: { egress?: unknown } }).spec?.egress,
    ).toEqual([
      {
        to: [{ ipBlock: { cidr: "172.20.0.10/32" } }],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
      { to: [{ domainNames: ["api.example.com", "cdn.example.com"] }] },
    ]);
    expect(updatedPolicy?.metadata?.finalizers).toEqual([
      "networking.k8s.aws/anp-resources",
    ]);
  });

  test("updates an existing CiliumNetworkPolicy and cleans up stale duplicate managed policies", async () => {
    const policyName = "mcp-egress-mcp-mcp-test-server";
    const { api: networkingApi } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies } = makeStatefulCustomObjectsApi({
      resource: {
        group: "cilium.io",
        version: "v2",
        plural: "ciliumnetworkpolicies",
      },
    });
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: true,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "cilium" as const,
      supportsFqdn: true,
      supportsHttpMethods: false,
      message: null,
    };

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    const stalePolicy = structuredClone(policies.get(policyName));
    expect(stalePolicy).toBeDefined();
    if (!stalePolicy?.metadata) throw new Error("expected policy metadata");
    stalePolicy.metadata.name = "mcp-egress-generated-stale";
    policies.set(stalePolicy.metadata.name, stalePolicy);

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com", "*.example.org"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([policyName]);
    expect(customObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(
      1,
    );
    expect(customObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: "cilium.io",
      version: "v2",
      namespace: "default",
      plural: "ciliumnetworkpolicies",
      name: "mcp-egress-generated-stale",
    });
    expect(
      policies.get(policyName)?.metadata?.annotations?.[
        "archestra.io/network-policy-allowed-domains"
      ],
    ).toBe("api.example.com,*.example.org");
  });

  test("updates GKE FQDNNetworkPolicy while keeping the desired Kubernetes NetworkPolicy and cleaning stale duplicates", async () => {
    const policyName = "mcp-egress-mcp-mcp-test-server";
    const { api: networkingApi, policies: kubernetesPolicies } =
      makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: gkePolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "networking.gke.io",
          version: "v1alpha1",
          plural: "fqdnnetworkpolicies",
        },
      });
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: true,
      awsApplicationNetworkPolicy: false,
      provider: "gke-fqdn" as const,
      supportsFqdn: true,
      supportsHttpMethods: false,
      message: null,
    };

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com"],
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    const staleKubernetesPolicy = structuredClone(
      kubernetesPolicies.get(policyName),
    );
    expect(staleKubernetesPolicy).toBeDefined();
    if (!staleKubernetesPolicy?.metadata) {
      throw new Error("expected Kubernetes policy metadata");
    }
    staleKubernetesPolicy.metadata.name = "mcp-egress-generated-stale-k8s";
    kubernetesPolicies.set(
      staleKubernetesPolicy.metadata.name,
      staleKubernetesPolicy,
    );

    const staleGkePolicy = structuredClone(gkePolicies.get(policyName));
    expect(staleGkePolicy).toBeDefined();
    if (!staleGkePolicy?.metadata) {
      throw new Error("expected GKE policy metadata");
    }
    staleGkePolicy.metadata.name = "mcp-egress-generated-stale-gke";
    gkePolicies.set(staleGkePolicy.metadata.name, staleGkePolicy);

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedDomains: ["api.example.com", "cdn.example.com"],
        allowedCidrs: ["198.51.100.0/24"],
      }),
      networkPolicyCapabilities: capabilities,
    }).applyK8sNetworkPolicy();

    expect([...kubernetesPolicies.keys()]).toEqual([policyName]);
    expect([...gkePolicies.keys()]).toEqual([policyName]);
    expect(networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(
      1,
    );
    expect(customObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(
      1,
    );
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "mcp-egress-generated-stale-k8s",
      namespace: "default",
    });
    expect(customObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: "networking.gke.io",
      version: "v1alpha1",
      namespace: "default",
      plural: "fqdnnetworkpolicies",
      name: "mcp-egress-generated-stale-gke",
    });
    expect(
      gkePolicies.get(policyName)?.metadata?.annotations?.[
        "archestra.io/network-policy-allowed-domains"
      ],
    ).toBe("api.example.com,cdn.example.com");
  });

  test("deleting managed network policy also cleans up stale duplicate managed policies", async () => {
    const policyName = "mcp-egress-mcp-mcp-test-server";
    const { api: networkingApi, policies } = makeStatefulNetworkingApi();
    const capabilities = {
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes" as const,
      supportsFqdn: false,
      supportsHttpMethods: false,
      message: null,
    };

    const deployment = makeNetworkPolicyDeployment({
      networkingApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: capabilities,
    });
    await deployment.applyK8sNetworkPolicy();

    const stalePolicy = structuredClone(policies.get(policyName));
    expect(stalePolicy).toBeDefined();
    if (!stalePolicy?.metadata) throw new Error("expected policy metadata");
    stalePolicy.metadata.name = "mcp-egress-generated-stale";
    policies.set(stalePolicy.metadata.name, stalePolicy);

    await deployment.deleteK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([]);
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: policyName,
      namespace: "default",
    });
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: "mcp-egress-generated-stale",
      namespace: "default",
    });
  });

  const PLAIN_CAPS = {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: false,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: false,
    provider: "kubernetes" as const,
    supportsFqdn: false,
    supportsHttpMethods: false,
    message: null,
  };
  const AWS_CAPS = {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: false,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: true,
    provider: "aws-application-network-policy" as const,
    supportsFqdn: true,
    supportsHttpMethods: false,
    message: null,
  };
  const CILIUM_CAPS = {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: true,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: false,
    provider: "cilium" as const,
    supportsFqdn: true,
    supportsHttpMethods: false,
    message: null,
  };
  const POLICY_NAME = "mcp-egress-mcp-mcp-test-server";
  const DNS_PORTS = [
    { protocol: "UDP", port: 53 },
    { protocol: "TCP", port: 53 },
  ];
  const FLOOR_PUBLIC_EGRESS = [
    {
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: [
              "10.0.0.0/8",
              "172.16.0.0/12",
              "192.168.0.0/16",
              "169.254.0.0/16",
              "100.64.0.0/10",
              "127.0.0.0/8",
              "0.0.0.0/8",
              "168.63.129.16/32",
            ],
          },
        },
      ],
    },
    {
      to: [
        {
          ipBlock: {
            cidr: "::/0",
            except: ["::1/128", "fc00::/7", "fe80::/10", "64:ff9b::/96"],
          },
        },
      ],
    },
  ];
  // Plain NetworkPolicy floor: DNS to the kube-dns pods by label (DNAT-proof),
  // not the resolver ClusterIP.
  const PLAIN_FLOOR_EGRESS = [
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
          },
          podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
        },
      ],
      ports: DNS_PORTS,
    },
    ...FLOOR_PUBLIC_EGRESS,
  ];
  // AWS ApplicationNetworkPolicy floor: cannot express selector peers, and with
  // no resolved ClusterIP the DNS bootstrap allows :53 to any IP.
  const AWS_FLOOR_EGRESS = [
    { to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: DNS_PORTS },
    ...FLOOR_PUBLIC_EGRESS,
  ];

  test("applies the SSRF floor as a plain NetworkPolicy for an unrestricted policy", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    const policy = policies.get(POLICY_NAME);
    expect(policy?.spec?.policyTypes).toEqual(["Egress"]);
    expect(policy?.spec?.egress).toEqual(PLAIN_FLOOR_EGRESS);
  });

  test("per-pod policy selector keys on app + mcp-server-id only, never the per-install name", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    const selector = policies.get(POLICY_NAME)?.spec?.podSelector?.matchLabels;
    expect(selector).toEqual({
      app: "mcp-server",
      "mcp-server-id": "test-server-id",
    });
    // mcp-server-name is per-install; including it in the AND-semantics selector
    // makes a multitenant policy select zero pods.
    expect(selector).not.toHaveProperty("mcp-server-name");
  });

  test("multitenant per-pod policy selects on the catalog-stable id, matching the shared pod", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
      multitenant: true,
    }).applyK8sNetworkPolicy();

    const selector = [...policies.values()][0]?.spec?.podSelector?.matchLabels;
    expect(selector).toEqual({
      app: "mcp-server",
      "mcp-server-id": "test-catalog-id",
    });
    expect(selector).not.toHaveProperty("mcp-server-name");
  });

  test("applies the SSRF floor for a built-in (null) policy — the case the union bug silently opened", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    expect(policies.get(POLICY_NAME)?.spec?.egress).toEqual(PLAIN_FLOOR_EGRESS);
  });

  test("emits the floor as an ApplicationNetworkPolicy on AWS and removes the plain NetworkPolicy", async () => {
    const { api: networkingApi, policies: kubernetesPolicies } =
      makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: anpPolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "networking.k8s.aws",
          version: "v1alpha1",
          plural: "applicationnetworkpolicies",
        },
      });

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: AWS_CAPS,
    }).applyK8sNetworkPolicy();

    const anp = anpPolicies.get(POLICY_NAME);
    expect((anp as { kind?: string })?.kind).toBe("ApplicationNetworkPolicy");
    expect(anp?.spec?.egress).toEqual(AWS_FLOOR_EGRESS);
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: POLICY_NAME,
      namespace: "default",
    });
    expect([...kubernetesPolicies.keys()]).not.toContain(POLICY_NAME);
  });

  test("emits a restricted CIDR-only allow-list as an ApplicationNetworkPolicy on AWS", async () => {
    const { api: networkingApi } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: anpPolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "networking.k8s.aws",
          version: "v1alpha1",
          plural: "applicationnetworkpolicies",
        },
      });

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: AWS_CAPS,
    }).applyK8sNetworkPolicy();

    const anp = anpPolicies.get(POLICY_NAME);
    expect((anp as { kind?: string })?.kind).toBe("ApplicationNetworkPolicy");
    const egress = (anp?.spec?.egress ?? []) as Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>;
    }>;
    expect(
      egress.some((rule) =>
        rule.to?.some((peer) => peer.ipBlock?.cidr === "203.0.113.0/24"),
      ),
    ).toBe(true);
  });

  test("emits off as a deny-all ApplicationNetworkPolicy on AWS, not an unenforced plain NetworkPolicy", async () => {
    const { api: networkingApi } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: anpPolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "networking.k8s.aws",
          version: "v1alpha1",
          plural: "applicationnetworkpolicies",
        },
      });

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "off" }),
      networkPolicyCapabilities: AWS_CAPS,
    }).applyK8sNetworkPolicy();

    const anp = anpPolicies.get(POLICY_NAME);
    expect((anp as { kind?: string })?.kind).toBe("ApplicationNetworkPolicy");
    expect(anp?.spec?.egress).toEqual([]);
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: POLICY_NAME,
      namespace: "default",
    });
  });

  test("emits the unrestricted floor as a plain NetworkPolicy on Cilium, not a CiliumNetworkPolicy", async () => {
    const { api: networkingApi, policies } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: ciliumPolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "cilium.io",
          version: "v2",
          plural: "ciliumnetworkpolicies",
        },
      });

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: CILIUM_CAPS,
    }).applyK8sNetworkPolicy();

    expect(policies.get(POLICY_NAME)?.spec?.egress).toEqual(PLAIN_FLOOR_EGRESS);
    expect(ciliumPolicies.has(POLICY_NAME)).toBe(false);
  });

  test("emits the floor as an ApplicationNetworkPolicy for a built-in (null) policy on AWS", async () => {
    const { api: networkingApi } = makeStatefulNetworkingApi();
    const { api: customObjectsApi, policies: anpPolicies } =
      makeStatefulCustomObjectsApi({
        resource: {
          group: "networking.k8s.aws",
          version: "v1alpha1",
          plural: "applicationnetworkpolicies",
        },
      });

    await makeNetworkPolicyDeployment({
      networkingApi,
      customObjectsApi,
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      networkPolicyCapabilities: AWS_CAPS,
    }).applyK8sNetworkPolicy();

    const anp = anpPolicies.get(POLICY_NAME);
    expect((anp as { kind?: string })?.kind).toBe("ApplicationNetworkPolicy");
    expect(anp?.spec?.egress).toEqual(AWS_FLOOR_EGRESS);
  });

  test("reconciles in place when relaxing from a restricted policy to the unrestricted floor", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({
        allowedCidrs: ["203.0.113.0/24"],
      }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();
    expect(policies.get(POLICY_NAME)?.spec?.egress).not.toEqual(
      PLAIN_FLOOR_EGRESS,
    );

    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([POLICY_NAME]);
    expect(policies.get(POLICY_NAME)?.spec?.egress).toEqual(PLAIN_FLOOR_EGRESS);
  });

  test("reconciles in place when tightening from the unrestricted floor to off (deny-all)", async () => {
    const { api, policies } = makeStatefulNetworkingApi();
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();
    expect(policies.get(POLICY_NAME)?.spec?.egress).toEqual(PLAIN_FLOOR_EGRESS);

    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "off" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    expect([...policies.keys()]).toEqual([POLICY_NAME]);
    expect(policies.get(POLICY_NAME)?.spec?.egress).toEqual([]);
  });

  test("the namespace default-deny baseline survives per-pod policy cleanup", async () => {
    const baseline = buildEgressBaselineNetworkPolicy({
      name: "mcp-server-egress-baseline",
      labels: {
        "app.kubernetes.io/managed-by": "archestra",
        "archestra.io/resource": "mcp-egress-baseline",
      },
    });
    const { api, policies } = makeStatefulNetworkingApi([baseline]);

    // Applying a per-pod floor runs cleanupStaleManagedNetworkPolicies over the
    // namespace; the baseline's distinct resource label and broad app-only
    // selector must keep it out of that sweep.
    await makeNetworkPolicyDeployment({
      networkingApi: api,
      effectiveNetworkPolicy: makeNetworkPolicy({ egressMode: "unrestricted" }),
      networkPolicyCapabilities: PLAIN_CAPS,
    }).applyK8sNetworkPolicy();

    expect(policies.get("mcp-server-egress-baseline")).toBeDefined();
    expect(api.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-egress-baseline" }),
    );
  });
});

describe("K8sDeployment.removeDeployment", () => {
  function createK8sDeploymentWithMockedApis(
    mockK8sApi: Partial<k8s.CoreV1Api>,
    mockK8sAppsApi: Partial<k8s.AppsV1Api>,
    mockK8sNetworkingApi: Partial<k8s.NetworkingV1Api> = {
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    },
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: mockK8sAppsApi as k8s.AppsV1Api,
      k8sNetworkingApi: mockK8sNetworkingApi as k8s.NetworkingV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  test("removes deployment, service, and secret", async () => {
    const mockDeleteDeployment = vi.fn().mockResolvedValue({});
    const mockDeleteService = vi.fn().mockResolvedValue({});
    const mockDeleteSecret = vi.fn().mockResolvedValue({});
    const mockListSecret = vi.fn().mockResolvedValue({ items: [] });

    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
      deleteNamespacedSecret: mockDeleteSecret,
      listNamespacedSecret: mockListSecret,
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
    const mockListSecret = vi.fn().mockResolvedValue({ items: [] });

    const mockK8sApi = {
      deleteNamespacedService: mockDeleteService,
      deleteNamespacedSecret: mockDeleteSecret,
      listNamespacedSecret: mockListSecret,
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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "test-namespace",
      catalogItem: null,
    });
  }

  test("returns correct status summary for not_created state", () => {
    const k8sDeployment = createK8sDeploymentInstance();

    const summary = k8sDeployment.statusSummary;

    expect(summary.state).toBe("not_created");
    expect(summary.message).toBe("Deployment not created");
    expect(summary.error).toBeNull();
    expect(summary.serverName).toBe("test-server");
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

    const k8sDeployment = new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });

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

    const k8sDeployment = new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "custom-namespace",
      catalogItem: null,
    });

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

    const k8sDeployment = new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });

    expect(k8sDeployment.k8sDeploymentName).toBe("mcp-my-mcp-server");
  });
});

// Shared pod-lookup + caching tests (uses nodeSelector fetcher as representative)
describe("createPlatformPodSpecFetcher (shared pod-lookup logic)", () => {
  test.beforeEach(() => {
    resetPlatformNodeSelectorCache();
  });

  test("looks up pod by POD_NAME env var", async () => {
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

    process.env.POD_NAME = originalPodName;
  });

  test("ignores HOSTNAME when not running in-cluster (only uses POD_NAME)", async () => {
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

  test("returns null when pod has no matching spec field", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-no-selector";

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        containers: [{ name: "archestra" }],
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

  test("caches result after first call (only one API call)", async () => {
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

    const result1 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result1).toEqual({ cached: "value" });
    expect(mockReadPod).toHaveBeenCalledTimes(1);

    const result2 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result2).toEqual({ cached: "value" });
    expect(mockReadPod).toHaveBeenCalledTimes(1);

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

    const result2 = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result2).toBeNull();
    expect(mockReadPod).toHaveBeenCalledTimes(1);

    process.env.POD_NAME = originalPodName;
  });

  test("getCached returns null before any fetch", () => {
    expect(getCachedPlatformNodeSelector()).toBeNull();
  });

  test("getCached returns value after fetch", async () => {
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

  test("resetCache clears cached value", async () => {
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

  test("both fetchers share a single pod API call", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-shared";

    // Reset both caches to ensure clean state
    resetPlatformNodeSelectorCache();
    resetPlatformTolerationsCache();

    const mockReadPod = vi.fn().mockResolvedValue({
      spec: {
        nodeSelector: { "karpenter.sh/nodepool": "shared-pool" },
        tolerations: [
          {
            key: "dedicated",
            operator: "Equal",
            value: "platform",
            effect: "NoSchedule",
          },
        ],
      },
    });

    const mockK8sApi = {
      readNamespacedPod: mockReadPod,
    } as unknown as k8s.CoreV1Api;

    // Fetch nodeSelector first — triggers the shared pod lookup
    const ns = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(ns).toEqual({ "karpenter.sh/nodepool": "shared-pool" });
    expect(mockReadPod).toHaveBeenCalledTimes(1);

    // Fetch tolerations — should reuse the cached pod spec, no additional API call
    const tol = await fetchPlatformPodTolerations(mockK8sApi, "default");
    expect(tol).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ]);
    expect(mockReadPod).toHaveBeenCalledTimes(1); // Still only one call

    process.env.POD_NAME = originalPodName;
  });
});

// Extractor-specific tests for nodeSelector
describe("fetchPlatformPodNodeSelector (extractor)", () => {
  test.beforeEach(() => {
    resetPlatformNodeSelectorCache();
  });

  test("extracts spec.nodeSelector", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "test-pod";

    const mockK8sApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        spec: {
          nodeSelector: { "karpenter.sh/nodepool": "general-purpose" },
          tolerations: [{ key: "other", operator: "Exists" }],
        },
      }),
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodNodeSelector(mockK8sApi, "default");
    expect(result).toEqual({ "karpenter.sh/nodepool": "general-purpose" });

    process.env.POD_NAME = originalPodName;
  });
});

// Extractor-specific tests for tolerations
describe("fetchPlatformPodTolerations (extractor)", () => {
  test.beforeEach(() => {
    resetPlatformTolerationsCache();
  });

  test("extracts spec.tolerations", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "test-pod";

    const mockK8sApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        spec: {
          nodeSelector: { "karpenter.sh/nodepool": "general-purpose" },
          tolerations: [
            {
              key: "dedicated",
              operator: "Equal",
              value: "platform",
              effect: "NoSchedule",
            },
          ],
        },
      }),
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodTolerations(mockK8sApi, "default");
    expect(result).toEqual([
      {
        key: "dedicated",
        operator: "Equal",
        value: "platform",
        effect: "NoSchedule",
      },
    ]);

    process.env.POD_NAME = originalPodName;
  });

  test("returns null when pod has empty tolerations array", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-empty-tol";

    const mockK8sApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        spec: { tolerations: [] },
      }),
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodTolerations(mockK8sApi, "default");
    expect(result).toBeNull();

    process.env.POD_NAME = originalPodName;
  });

  test("returns null when pod has no tolerations", async () => {
    const originalPodName = process.env.POD_NAME;
    process.env.POD_NAME = "archestra-platform-no-tol";

    const mockK8sApi = {
      readNamespacedPod: vi.fn().mockResolvedValue({
        spec: { containers: [{ name: "archestra" }] },
      }),
    } as unknown as k8s.CoreV1Api;

    const result = await fetchPlatformPodTolerations(mockK8sApi, "default");
    expect(result).toBeNull();

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

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: mockK8sApi as k8s.CoreV1Api,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
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

describe("K8sDeployment.createDockerRegistrySecrets", () => {
  function createDeploymentWithMockedK8sApi(
    mcpServerId: string,
    mockCreateSecret: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({}),
    mockReplaceSecret: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({}),
    teamId?: string | null,
  ): K8sDeployment {
    const mcpServer = {
      id: mcpServerId,
      name: "test-server",
      catalogId: "catalog-id",
      teamId: teamId ?? null,
    } as McpServer;

    const mockK8sApi = {
      createNamespacedSecret: mockCreateSecret,
      replaceNamespacedSecret: mockReplaceSecret,
    } as unknown as k8s.CoreV1Api;

    return new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: mockK8sApi,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  test("returns empty array when imagePullSecrets is undefined", async () => {
    const deployment = createDeploymentWithMockedK8sApi("srv-1");
    const result = await deployment.createDockerRegistrySecrets({}, undefined);
    expect(result).toEqual([]);
  });

  test("skips existing-source entries", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-2", mockCreate);
    const result = await deployment.createDockerRegistrySecrets({}, [
      { source: "existing", name: "my-secret" },
    ]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("creates secret with server and username in name", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-3", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      { "__regcred_password:quay.io:myuser": "secret123" },
      [
        {
          source: "credentials",
          server: "quay.io",
          username: "myuser",
          email: "a@b.com",
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("mcp-server-srv-3-regcred-quay.io-myuser");
    expect(mockCreate).toHaveBeenCalledOnce();

    // Verify the secret body
    const body = mockCreate.mock.calls[0][0].body;
    expect(body.type).toBe("kubernetes.io/dockerconfigjson");
    expect(body.metadata.name).toBe("mcp-server-srv-3-regcred-quay.io-myuser");

    // Verify dockerconfigjson content
    const decoded = JSON.parse(
      Buffer.from(body.data[".dockerconfigjson"], "base64").toString(),
    );
    expect(decoded.auths["quay.io"].username).toBe("myuser");
    expect(decoded.auths["quay.io"].password).toBe("secret123");
    expect(decoded.auths["quay.io"].email).toBe("a@b.com");
  });

  test("creates unique secrets for same server with different usernames", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-4", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      {
        "__regcred_password:ghcr.io:alice": "pass-alice",
        "__regcred_password:ghcr.io:bob": "pass-bob",
      },
      [
        {
          source: "credentials",
          server: "ghcr.io",
          username: "alice",
        },
        {
          source: "credentials",
          server: "ghcr.io",
          username: "bob",
        },
      ],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("mcp-server-srv-4-regcred-ghcr.io-alice");
    expect(result[1]).toBe("mcp-server-srv-4-regcred-ghcr.io-bob");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test("skips entry when password is missing from secret data", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-5", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      {}, // No passwords in secret data
      [
        {
          source: "credentials",
          server: "quay.io",
          username: "myuser",
        },
      ],
    );
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("lowercases and sanitizes server and username in secret name", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-6", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      { "__regcred_password:Quay.IO:MyUser@Corp": "pass" },
      [
        {
          source: "credentials",
          server: "Quay.IO",
          username: "MyUser@Corp",
        },
      ],
    );
    expect(result).toHaveLength(1);
    // Quay.IO → quay.io (lowercase, periods preserved by RFC 1123)
    // MyUser@Corp → myusercorp (lowercase, @ stripped)
    expect(result[0]).toBe("mcp-server-srv-6-regcred-quay.io-myusercorp");
  });

  test("secret name is DNS-1123 compliant (no trailing non-alphanumeric)", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-7", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      { "__regcred_password:registry.example.com:user-": "pass" },
      [
        {
          source: "credentials",
          server: "registry.example.com",
          username: "user-",
        },
      ],
    );
    expect(result).toHaveLength(1);
    // Verify no trailing non-alphanumeric characters
    expect(result[0]).toMatch(/[a-z0-9]$/);
  });

  test("replaces secret on 409 conflict (upsert)", async () => {
    const mockCreate = vi.fn().mockRejectedValue({ statusCode: 409 });
    const mockReplace = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi(
      "srv-8",
      mockCreate,
      mockReplace,
    );
    const result = await deployment.createDockerRegistrySecrets(
      { "__regcred_password:quay.io:user": "pass" },
      [
        {
          source: "credentials",
          server: "quay.io",
          username: "user",
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockReplace).toHaveBeenCalledOnce();
  });

  test("handles mixed existing and credentials entries", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi("srv-9", mockCreate);
    const result = await deployment.createDockerRegistrySecrets(
      { "__regcred_password:docker.io:ci-bot": "docker-pass" },
      [
        { source: "existing", name: "pre-existing-secret" },
        {
          source: "credentials",
          server: "docker.io",
          username: "ci-bot",
          email: "ci@example.com",
        },
        { source: "existing", name: "another-secret" },
      ],
    );
    // Only the credentials entry should produce a secret
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("docker.io");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  test("includes team-id label when mcpServer.teamId is set", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi(
      "srv-team",
      mockCreate,
      vi.fn().mockResolvedValue({}),
      "team-abc-123",
    );
    await deployment.createDockerRegistrySecrets(
      { "__regcred_password:quay.io:user": "pass" },
      [
        {
          source: "credentials",
          server: "quay.io",
          username: "user",
          email: "a@b.com",
        },
      ],
    );
    expect(mockCreate).toHaveBeenCalledOnce();
    const body = mockCreate.mock.calls[0][0].body;
    expect(body.metadata.labels["team-id"]).toBe("team-abc-123");
  });

  test("omits team-id label when mcpServer.teamId is null", async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const deployment = createDeploymentWithMockedK8sApi(
      "srv-no-team",
      mockCreate,
      vi.fn().mockResolvedValue({}),
      null,
    );
    await deployment.createDockerRegistrySecrets(
      { "__regcred_password:quay.io:user": "pass" },
      [
        {
          source: "credentials",
          server: "quay.io",
          username: "user",
          email: "a@b.com",
        },
      ],
    );
    expect(mockCreate).toHaveBeenCalledOnce();
    const body = mockCreate.mock.calls[0][0].body;
    expect(body.metadata.labels["team-id"]).toBeUndefined();
  });
});

describe("K8sDeployment.collectImagePullSecretNames", () => {
  test("returns empty array when no secrets provided", () => {
    expect(K8sDeployment.collectImagePullSecretNames(undefined, [])).toEqual(
      [],
    );
  });

  test("collects existing secret names", () => {
    const result = K8sDeployment.collectImagePullSecretNames(
      [
        { source: "existing", name: "secret-a" },
        { source: "existing", name: "secret-b" },
      ],
      [],
    );
    expect(result).toEqual([{ name: "secret-a" }, { name: "secret-b" }]);
  });

  test("skips credentials entries (they come from generatedRegcredNames)", () => {
    const result = K8sDeployment.collectImagePullSecretNames(
      [
        { source: "existing", name: "existing-one" },
        {
          source: "credentials",
          server: "quay.io",
          username: "user",
        },
      ],
      [],
    );
    expect(result).toEqual([{ name: "existing-one" }]);
  });

  test("merges existing names with generated regcred names", () => {
    const result = K8sDeployment.collectImagePullSecretNames(
      [{ source: "existing", name: "pre-existing" }],
      ["mcp-server-x-regcred-quay.io-user"],
    );
    expect(result).toEqual([
      { name: "pre-existing" },
      { name: "mcp-server-x-regcred-quay.io-user" },
    ]);
  });

  test("returns only generated names when no existing entries", () => {
    const result = K8sDeployment.collectImagePullSecretNames(
      [
        {
          source: "credentials",
          server: "ghcr.io",
          username: "bot",
        },
      ],
      ["generated-secret-1", "generated-secret-2"],
    );
    expect(result).toEqual([
      { name: "generated-secret-1" },
      { name: "generated-secret-2" },
    ]);
  });
});

describe("K8sDeployment.ensureHttpServerConfigured cluster domain", () => {
  function createDeploymentForClusterDomainTest(
    clusterDomain: string,
  ): K8sDeployment {
    const mcpServer = {
      id: "http-server-id",
      name: "http-server",
      catalogId: "catalog-http",
      secretId: null,
      ownerId: null,
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as McpServer;

    const mockReadService = vi.fn().mockRejectedValue({ statusCode: 404 });
    const mockCreateService = vi.fn().mockResolvedValue({});

    const mockK8sApi = {
      readNamespacedService: mockReadService,
      createNamespacedService: mockCreateService,
    } as unknown as k8s.CoreV1Api;

    const deployment = new K8sDeployment({
      mcpServer: mcpServer,
      k8sApi: mockK8sApi,
      k8sAppsApi: {} as k8s.AppsV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });

    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    (deployment as any).catalogItem = {
      id: "catalog-http",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    };

    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = true;
    config.orchestrator.kubernetes.clusterDomain = clusterDomain;

    return deployment;
  }

  test("uses cluster.local by default", async () => {
    const originalLoadFromCluster =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;
    const originalClusterDomain = config.orchestrator.kubernetes.clusterDomain;

    try {
      const deployment = createDeploymentForClusterDomainTest("cluster.local");

      // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
      await (deployment as any).ensureHttpServerConfigured();

      expect(deployment.httpEndpointUrl).toBe(
        "http://mcp-http-server-service.default.svc.cluster.local:8080/mcp",
      );
    } finally {
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
        originalLoadFromCluster;
      config.orchestrator.kubernetes.clusterDomain = originalClusterDomain;
    }
  });

  test("uses custom cluster domain when ARCHESTRA_ORCHESTRATOR_K8S_CLUSTER_DOMAIN is set", async () => {
    const originalLoadFromCluster =
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster;
    const originalClusterDomain = config.orchestrator.kubernetes.clusterDomain;

    try {
      const deployment =
        createDeploymentForClusterDomainTest("my-custom.domain");

      // biome-ignore lint/suspicious/noExplicitAny: Accessing private method for testing
      await (deployment as any).ensureHttpServerConfigured();

      expect(deployment.httpEndpointUrl).toBe(
        "http://mcp-http-server-service.default.svc.my-custom.domain:8080/mcp",
      );
    } finally {
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster =
        originalLoadFromCluster;
      config.orchestrator.kubernetes.clusterDomain = originalClusterDomain;
    }
  });
});

describe("K8sDeployment.streamLogs", () => {
  function makeRunningPod(name = "mcp-test-pod"): k8s.V1Pod {
    return {
      metadata: { name },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "mcp-server",
            ready: true,
            restartCount: 0,
            state: { running: { startedAt: new Date() } },
            image: "test",
            imageID: "test",
            started: true,
            ready_: true,
          } as unknown as k8s.V1ContainerStatus,
        ],
      },
    } as k8s.V1Pod;
  }

  function makePendingPod(name = "mcp-test-pod"): k8s.V1Pod {
    return {
      metadata: { name },
      status: {
        phase: "Pending",
        containerStatuses: [],
      },
    } as k8s.V1Pod;
  }

  function collectStream(stream: NodeJS.WritableStream): {
    text: () => string;
  } {
    const chunks: string[] = [];
    const original = stream.write.bind(stream);
    (stream as unknown as { write: typeof stream.write }).write = ((
      chunk: string | Buffer,
    ) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return original(chunk);
    }) as typeof stream.write;
    return { text: () => chunks.join("") };
  }

  test("when pod is Pending, writes events snapshot then upgrades to live logs once Ready", async () => {
    const deployment = createK8sDeploymentInstance();
    const ac = new AbortController();

    const pendingPod = makePendingPod();
    const runningPod = makeRunningPod();
    vi.spyOn(
      deployment as unknown as {
        findAnyPodForDeployment: () => Promise<k8s.V1Pod | undefined>;
      },
      "findAnyPodForDeployment",
    )
      // initial check (in streamLogs) - Pending
      .mockResolvedValueOnce(pendingPod)
      // first poll - still Pending
      .mockResolvedValueOnce(pendingPod)
      // second poll - now Running
      .mockResolvedValueOnce(runningPod);

    vi.spyOn(
      deployment as unknown as { getDeploymentEvents: () => Promise<string> },
      "getDeploymentEvents",
    ).mockResolvedValue("Normal Scheduled  test event\n");

    // Capture the stream the production code passes to k8sLog.log so we can
    // verify it gets called with a Running pod. We end the stream to model
    // a pod going away (e.g. reinstall) and immediately abort so the
    // "wait for replacement pod" recovery loop tears down cleanly.
    const k8sLogMock = vi.fn(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        out: NodeJS.WritableStream,
      ) => {
        out.write("real container log line\n");
        out.end();
        ac.abort();
        return { abort: () => {} };
      },
    );
    (deployment as unknown as { k8sLog: { log: typeof k8sLogMock } }).k8sLog = {
      log: k8sLogMock,
    };

    const out = new PassThrough();
    const captured = collectStream(out);

    vi.useFakeTimers();
    try {
      const done = deployment.streamLogs(out, 100, ac.signal);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }

    const text = captured.text();
    expect(text).toContain("--- Kubernetes Events ---");
    expect(text).toContain("test event");
    expect(text).toContain("is now Running, switching to live logs");
    expect(text).toContain("real container log line");
    expect(k8sLogMock).toHaveBeenCalledTimes(1);
    expect(k8sLogMock.mock.calls[0]?.[1]).toBe("mcp-test-pod");
  });

  test("when the running pod's log stream ends without abort, waits for a replacement pod and resumes streaming", async () => {
    const deployment = createK8sDeploymentInstance();
    const ac = new AbortController();

    const firstPod = makeRunningPod("mcp-old-pod");
    const replacementPod = makeRunningPod("mcp-new-pod");
    vi.spyOn(
      deployment as unknown as {
        findAnyPodForDeployment: () => Promise<k8s.V1Pod | undefined>;
      },
      "findAnyPodForDeployment",
    )
      // initial check - first pod is Running
      .mockResolvedValueOnce(firstPod)
      // poll fires after the first log stream ends - replacement is up
      .mockResolvedValueOnce(replacementPod);

    vi.spyOn(
      deployment as unknown as { getDeploymentEvents: () => Promise<string> },
      "getDeploymentEvents",
    ).mockResolvedValue("");

    let invocation = 0;
    const k8sLogMock = vi.fn(
      async (
        _ns: string,
        podName: string,
        _container: string,
        out: NodeJS.WritableStream,
      ) => {
        invocation++;
        out.write(`logs from ${podName}\n`);
        if (invocation === 1) {
          // simulate the pod being deleted under us (reinstall, eviction)
          out.end();
        } else {
          out.end();
          ac.abort();
        }
        return { abort: () => {} };
      },
    );
    (deployment as unknown as { k8sLog: { log: typeof k8sLogMock } }).k8sLog = {
      log: k8sLogMock,
    };

    const out = new PassThrough();
    const captured = collectStream(out);

    vi.useFakeTimers();
    try {
      const done = deployment.streamLogs(out, 100, ac.signal);
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }

    const text = captured.text();
    expect(text).toContain("logs from mcp-old-pod");
    expect(text).toContain("waiting for replacement pod");
    expect(text).toContain("logs from mcp-new-pod");
    expect(k8sLogMock).toHaveBeenCalledTimes(2);
    expect(k8sLogMock.mock.calls[0]?.[1]).toBe("mcp-old-pod");
    expect(k8sLogMock.mock.calls[1]?.[1]).toBe("mcp-new-pod");
  });

  test("aborting while polling stops the wait and does not call k8sLog.log", async () => {
    const deployment = createK8sDeploymentInstance();

    vi.spyOn(
      deployment as unknown as {
        findAnyPodForDeployment: () => Promise<k8s.V1Pod | undefined>;
      },
      "findAnyPodForDeployment",
    ).mockResolvedValue(makePendingPod());

    vi.spyOn(
      deployment as unknown as { getDeploymentEvents: () => Promise<string> },
      "getDeploymentEvents",
    ).mockResolvedValue("");

    const k8sLogMock = vi.fn();
    (deployment as unknown as { k8sLog: { log: typeof k8sLogMock } }).k8sLog = {
      log: k8sLogMock,
    };

    const out = new PassThrough();
    const ac = new AbortController();

    vi.useFakeTimers();
    try {
      const done = deployment.streamLogs(out, 100, ac.signal);
      // Let the events snapshot write, then abort before the next poll fires.
      await vi.advanceTimersByTimeAsync(500);
      ac.abort();
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }

    expect(k8sLogMock).not.toHaveBeenCalled();
  });

  test("ready-poll does not accumulate abort listeners on the signal across iterations", async () => {
    const deployment = createK8sDeploymentInstance();
    const ac = new AbortController();

    // Pod never becomes Ready, so every 2s iteration takes the timeout path.
    vi.spyOn(
      deployment as unknown as {
        findAnyPodForDeployment: () => Promise<k8s.V1Pod | undefined>;
      },
      "findAnyPodForDeployment",
    ).mockResolvedValue(makePendingPod());

    const out = new PassThrough();

    vi.useFakeTimers();
    try {
      const done = (
        deployment as unknown as {
          pollAndStreamLogsWhenReady(
            stream: NodeJS.WritableStream,
            lines: number,
            abortSignal?: AbortSignal,
          ): Promise<void>;
        }
      ).pollAndStreamLogsWhenReady(out, 100, ac.signal);

      const listenerCounts: number[] = [];
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(2000);
        listenerCounts.push(getEventListeners(ac.signal, "abort").length);
      }
      // Only the in-flight iteration may hold a listener; finished
      // iterations must have removed theirs.
      expect(Math.max(...listenerCounts)).toBeLessThanOrEqual(1);

      ac.abort();
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }

    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});

describe("K8sDeployment pod lookup fallbacks", () => {
  test("findPodForDeployment fallback lists only app=mcp-server pods", async () => {
    const deployment = createK8sDeploymentInstance();
    const deploymentName = (deployment as unknown as { deploymentName: string })
      .deploymentName;

    const listNamespacedPod = vi
      .fn()
      // lookup by mcp-server-id label finds no running pod
      .mockResolvedValueOnce({ items: [] })
      // multi-tenant fallback list
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { name: `${deploymentName}-abc12` },
            status: { phase: "Running" },
          },
        ],
      });
    (deployment as unknown as { k8sApi: k8s.CoreV1Api }).k8sApi = {
      listNamespacedPod,
    } as unknown as k8s.CoreV1Api;

    await expect(deployment.hasRunningPod()).resolves.toBe(true);

    expect(listNamespacedPod).toHaveBeenNthCalledWith(2, {
      namespace: "default",
      labelSelector: "app=mcp-server",
    });
  });

  test("findAnyPodForDeployment fallback lists only app=mcp-server pods", async () => {
    const deployment = createK8sDeploymentInstance();
    const deploymentName = (deployment as unknown as { deploymentName: string })
      .deploymentName;

    const ownPod = {
      metadata: { name: `${deploymentName}-xyz99` },
      status: { phase: "Pending" },
    };
    const listNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [ownPod] });
    (deployment as unknown as { k8sApi: k8s.CoreV1Api }).k8sApi = {
      listNamespacedPod,
    } as unknown as k8s.CoreV1Api;

    const pod = await (
      deployment as unknown as {
        findAnyPodForDeployment(): Promise<k8s.V1Pod | undefined>;
      }
    ).findAnyPodForDeployment();

    expect(pod?.metadata?.name).toBe(`${deploymentName}-xyz99`);
    expect(listNamespacedPod).toHaveBeenNthCalledWith(2, {
      namespace: "default",
      labelSelector: "app=mcp-server",
    });
  });
});

describe("K8sDeployment image pull failure handling", () => {
  function makeDeploymentWithMockedApis(params: {
    listNamespacedPod: ReturnType<typeof vi.fn>;
    readNamespacedDeployment?: ReturnType<typeof vi.fn>;
  }): K8sDeployment {
    const mockMcpServer = {
      id: "test-server-id",
      name: "test-server",
      // null catalogId so getCatalogItem() short-circuits without a DB lookup
      catalogId: null,
    } as unknown as McpServer;

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {
        listNamespacedPod: params.listNamespacedPod,
      } as unknown as k8s.CoreV1Api,
      k8sAppsApi: {
        readNamespacedDeployment: params.readNamespacedDeployment ?? vi.fn(),
      } as unknown as k8s.AppsV1Api,
      k8sNetworkingApi: {} as k8s.NetworkingV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  function makeWaitingPod(reason: string, message: string): k8s.V1Pod {
    return {
      metadata: {
        name: "test-server-abc123",
        creationTimestamp: new Date(),
      },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "mcp-server",
            ready: false,
            restartCount: 0,
            state: { waiting: { reason, message } },
          },
        ],
      },
    } as k8s.V1Pod;
  }

  const runningPod = {
    metadata: {
      name: "test-server-abc123",
      creationTimestamp: new Date(),
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "mcp-server",
          ready: true,
          restartCount: 0,
          state: { running: {} },
        },
      ],
    },
  } as k8s.V1Pod;

  const imagePullPod = makeWaitingPod(
    "ImagePullBackOff",
    'Back-off pulling image "ghcr.io/example/mcp:latest"',
  );

  describe("refreshState", () => {
    test("keeps state pending on transient image pull errors", async () => {
      const listNamespacedPod = vi
        .fn()
        .mockResolvedValue({ items: [imagePullPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValue({ status: { availableReplicas: 0 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });
      // @ts-expect-error - accessing private property for testing
      deployment.state = "pending";

      await deployment.refreshState();

      expect(deployment.statusSummary.state).toBe("pending");
      expect(deployment.statusSummary.error).toContain(
        "Back-off pulling image",
      );
    });

    test("recovers to running once the kubelet pull succeeds", async () => {
      const listNamespacedPod = vi
        .fn()
        // first refresh: findAnyPodForDeployment + failure check see the pull error
        .mockResolvedValueOnce({ items: [imagePullPod] })
        .mockResolvedValueOnce({ items: [imagePullPod] })
        // second refresh: pod is running
        .mockResolvedValue({ items: [runningPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValueOnce({ status: { availableReplicas: 0 } })
        .mockResolvedValue({ status: { availableReplicas: 1 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });
      // @ts-expect-error - accessing private property for testing
      deployment.state = "pending";

      await deployment.refreshState();
      expect(deployment.statusSummary.state).toBe("pending");

      await deployment.refreshState();
      expect(deployment.statusSummary.state).toBe("running");
      expect(deployment.statusSummary.error).toBeNull();
    });

    test("still marks terminal container failures as failed", async () => {
      const crashLoopPod = makeWaitingPod(
        "CrashLoopBackOff",
        "back-off 5m0s restarting failed container",
      );
      const listNamespacedPod = vi
        .fn()
        .mockResolvedValue({ items: [crashLoopPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValue({ status: { availableReplicas: 0 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });
      // @ts-expect-error - accessing private property for testing
      deployment.state = "running";

      await deployment.refreshState();

      expect(deployment.statusSummary.state).toBe("failed");
      expect(deployment.statusSummary.error).toContain(
        "restarting failed container",
      );
    });
  });

  describe("waitForDeploymentReady", () => {
    test("keeps waiting through image pull errors and succeeds once the pull completes", async () => {
      const listNamespacedPod = vi
        .fn()
        // attempt 1: failure scan sees the pull error (must not fail fast)
        .mockResolvedValueOnce({ items: [imagePullPod] })
        // attempt 2: pod is running
        .mockResolvedValue({ items: [runningPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValueOnce({ status: { availableReplicas: 0 } })
        .mockResolvedValue({ status: { availableReplicas: 1 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });

      await expect(
        deployment.waitForDeploymentReady(5, 1),
      ).resolves.toBeUndefined();
      expect(deployment.statusSummary.state).toBe("running");
      expect(deployment.statusSummary.error).toBeNull();
    });

    test("fails fast on terminal container states", async () => {
      const crashLoopPod = makeWaitingPod(
        "CrashLoopBackOff",
        "back-off 5m0s restarting failed container",
      );
      const listNamespacedPod = vi
        .fn()
        .mockResolvedValue({ items: [crashLoopPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValue({ status: { availableReplicas: 0 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });

      await expect(deployment.waitForDeploymentReady(5, 1)).rejects.toThrow(
        /CrashLoopBackOff/,
      );
      expect(deployment.statusSummary.state).toBe("failed");
    });

    test("includes the last image pull error when timing out", async () => {
      const listNamespacedPod = vi
        .fn()
        .mockResolvedValue({ items: [imagePullPod] });
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValue({ status: { availableReplicas: 0 } });

      const deployment = makeDeploymentWithMockedApis({
        listNamespacedPod,
        readNamespacedDeployment,
      });

      await expect(deployment.waitForDeploymentReady(2, 1)).rejects.toThrow(
        /did not become ready after 2 attempts.*ImagePullBackOff/,
      );
    });
  });
});

describe("K8sDeployment selector self-heal (multitenant drift)", () => {
  const notFound = { statusCode: 404, message: "not found" };

  function makeDeployment(params: {
    readNamespacedPod?: ReturnType<typeof vi.fn>;
    readNamespacedDeployment: ReturnType<typeof vi.fn>;
    deleteNamespacedDeployment?: ReturnType<typeof vi.fn>;
    createNamespacedDeployment?: ReturnType<typeof vi.fn>;
  }): K8sDeployment {
    const mockMcpServer = {
      id: "current-install-id",
      name: "test-server",
      // null catalogId so getCatalogItem() short-circuits without a DB lookup;
      // the recreate path then fails fast on missing local config, which is all
      // we need — the assertion is that the drifted deployment was deleted first.
      catalogId: null,
    } as unknown as McpServer;

    return new K8sDeployment({
      mcpServer: mockMcpServer,
      k8sApi: {
        readNamespacedPod: params.readNamespacedPod ?? vi.fn(),
      } as unknown as k8s.CoreV1Api,
      k8sAppsApi: {
        readNamespacedDeployment: params.readNamespacedDeployment,
        deleteNamespacedDeployment:
          params.deleteNamespacedDeployment ?? vi.fn().mockResolvedValue({}),
        createNamespacedDeployment:
          params.createNamespacedDeployment ?? vi.fn().mockResolvedValue({}),
      } as unknown as k8s.AppsV1Api,
      k8sNetworkingApi: {} as k8s.NetworkingV1Api,
      k8sAttach: {} as Attach,
      k8sLog: {} as Log,
      k8sExec: {} as Exec,
      namespace: "default",
      catalogItem: null,
    });
  }

  // Regression: a Deployment created before the catalog-stable selector fix
  // (#6340) keeps its old per-install `mcp-server-id` pod label while the shared
  // Service's selector is reconciled to the catalog-stable id. The two diverge,
  // the Service selects zero pods, and every connect/read fails ("fetch failed").
  // A Deployment selector is immutable, so the only fix is delete + recreate.
  test("recreates a deployment whose mcp-server-id selector drifted from the target", async () => {
    const readNamespacedPod = vi.fn().mockRejectedValue(notFound); // no legacy bare pod
    // 1st read: the deployment exists with a STALE selector (a different
    // install's id). After deletion every read returns 404, which drains
    // waitForDeploymentAbsent and sends the recreate down the create path.
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({
        spec: {
          selector: { matchLabels: { "mcp-server-id": "stale-install-id" } },
        },
        status: { availableReplicas: 1 },
      })
      .mockRejectedValue(notFound);
    const deleteNamespacedDeployment = vi.fn().mockResolvedValue({});

    const deployment = makeDeployment({
      readNamespacedPod,
      readNamespacedDeployment,
      deleteNamespacedDeployment,
    });

    // The recreate fails fast in this mock (no catalog/local config) — expected.
    await expect(deployment.startOrCreateDeployment()).rejects.toThrow();

    expect(deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: deployment.k8sDeploymentName }),
    );
  });

  // Regression: the pod's egress policy MUST be applied before the deployment is
  // created. A pod that starts before its per-pod policy lands is selected only
  // by the namespace deny-all baseline (no DNS, no egress) and crashloops on
  // startup connectivity.
  test("applies the per-pod egress policy before creating the deployment", async () => {
    const createNamespacedDeployment = vi.fn().mockResolvedValue({});
    const deployment = makeDeployment({
      readNamespacedPod: vi.fn().mockRejectedValue(notFound), // no legacy bare pod
      readNamespacedDeployment: vi.fn().mockRejectedValue(notFound), // 404 → create path
      createNamespacedDeployment,
    });

    // Stub everything the create path touches except the two calls we're ordering.
    vi.spyOn(
      deployment as unknown as { getCatalogItem: () => unknown },
      "getCatalogItem",
    ).mockResolvedValue({ localConfig: { dockerImage: "img" } });
    vi.spyOn(
      deployment as unknown as { needsHttpPort: () => unknown },
      "needsHttpPort",
    ).mockResolvedValue(false);
    vi.spyOn(
      deployment as unknown as { generateDeploymentSpec: () => unknown },
      "generateDeploymentSpec",
    ).mockReturnValue({});
    vi.spyOn(
      deployment as unknown as { ensureHttpServerConfigured: () => unknown },
      "ensureHttpServerConfigured",
    ).mockResolvedValue(undefined);
    const applySpy = vi
      .spyOn(deployment, "applyK8sNetworkPolicy")
      .mockResolvedValue(undefined);

    await deployment.startOrCreateDeployment();

    expect(applySpy).toHaveBeenCalled();
    expect(createNamespacedDeployment).toHaveBeenCalled();
    expect(applySpy.mock.invocationCallOrder[0]).toBeLessThan(
      createNamespacedDeployment.mock.invocationCallOrder[0],
    );
  });

  // A concurrent reconcile (another orchestrator replica) can create the Deployment
  // between our 404 read and our create call. The resulting 409 must re-enter the
  // reconcile (re-read + validate the now-existing deployment), not blindly assume
  // success — a stale-selector deployment left by an older replica must still be
  // self-healed, and a healthy one must not be marked failed.
  test("on a 409 (concurrent create), re-reconciles the now-existing deployment", async () => {
    const conflict = { statusCode: 409, message: "already exists" };
    // Initial read: absent (→ create path). Create conflicts (409). The re-entry
    // then reads the now-present deployment and reconciles it (here: not-ready).
    const readNamespacedDeployment = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValue({ status: {} });
    const createNamespacedDeployment = vi.fn().mockRejectedValue(conflict);
    const deployment = makeDeployment({
      readNamespacedPod: vi.fn().mockRejectedValue(notFound), // no legacy bare pod
      readNamespacedDeployment,
      createNamespacedDeployment,
    });
    vi.spyOn(
      deployment as unknown as { getCatalogItem: () => unknown },
      "getCatalogItem",
    ).mockResolvedValue({ localConfig: { dockerImage: "img" } });
    vi.spyOn(
      deployment as unknown as { needsHttpPort: () => unknown },
      "needsHttpPort",
    ).mockResolvedValue(false);
    vi.spyOn(
      deployment as unknown as { generateDeploymentSpec: () => unknown },
      "generateDeploymentSpec",
    ).mockReturnValue({});
    vi.spyOn(
      deployment as unknown as {
        checkPodContainerStatusesForFailure: () => unknown;
      },
      "checkPodContainerStatusesForFailure",
    ).mockResolvedValue({ hasFailed: false, isTransientImagePull: false });
    vi.spyOn(
      deployment as unknown as { ensureHttpServerConfigured: () => unknown },
      "ensureHttpServerConfigured",
    ).mockResolvedValue(undefined);
    const applySpy = vi
      .spyOn(deployment, "applyK8sNetworkPolicy")
      .mockResolvedValue(undefined);

    await expect(deployment.startOrCreateDeployment()).resolves.toBeUndefined();
    // Re-read on conflict (not a blind "continue"), and no create-retry loop.
    expect(readNamespacedDeployment.mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(createNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalled();
  });

  // Regression: the reconcile path for an existing-but-not-ready deployment must
  // also (re)apply the egress policy before HTTP config, so a slow or failing
  // Service setup can't leave an already-created pod on the deny-all baseline.
  test("reapplies the egress policy before HTTP config on a not-ready deployment, even when HTTP config fails", async () => {
    const deployment = makeDeployment({
      readNamespacedPod: vi.fn().mockRejectedValue(notFound), // no legacy bare pod
      readNamespacedDeployment: vi.fn().mockResolvedValue({ status: {} }), // exists, not ready
    });
    vi.spyOn(
      deployment as unknown as {
        checkPodContainerStatusesForFailure: () => unknown;
      },
      "checkPodContainerStatusesForFailure",
    ).mockResolvedValue({ hasFailed: false, isTransientImagePull: false });
    const applySpy = vi
      .spyOn(deployment, "applyK8sNetworkPolicy")
      .mockResolvedValue(undefined);
    const httpSpy = vi
      .spyOn(
        deployment as unknown as { ensureHttpServerConfigured: () => unknown },
        "ensureHttpServerConfigured",
      )
      .mockRejectedValue(new Error("Service setup failed"));

    await expect(deployment.startOrCreateDeployment()).rejects.toThrow(
      "Service setup failed",
    );

    // The policy was (re)applied before — and independently of — the HTTP failure.
    expect(applySpy).toHaveBeenCalled();
    expect(applySpy.mock.invocationCallOrder[0]).toBeLessThan(
      httpSpy.mock.invocationCallOrder[0],
    );
  });

  describe("waitForDeploymentAbsent", () => {
    test("resolves once the deployment returns 404", async () => {
      const readNamespacedDeployment = vi
        .fn()
        .mockResolvedValueOnce({}) // still present
        .mockRejectedValue(notFound); // then gone
      const deployment = makeDeployment({ readNamespacedDeployment });

      await expect(
        // @ts-expect-error - exercising a private method directly
        deployment.waitForDeploymentAbsent(5, 1),
      ).resolves.toBeUndefined();
    });

    test("throws if the deployment never disappears", async () => {
      const readNamespacedDeployment = vi.fn().mockResolvedValue({});
      const deployment = makeDeployment({ readNamespacedDeployment });

      await expect(
        // @ts-expect-error - exercising a private method directly
        deployment.waitForDeploymentAbsent(2, 1),
      ).rejects.toThrow(/was not deleted after 2 attempts/);
    });
  });
});
