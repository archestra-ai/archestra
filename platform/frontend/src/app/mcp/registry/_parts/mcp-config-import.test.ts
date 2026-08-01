import { describe, expect, it } from "vitest";
import { parseMcpArguments, parseMcpConfigJson } from "./mcp-config-import";

describe("parseMcpArguments", () => {
  it("keeps newline-delimited arguments", () => {
    expect(parseMcpArguments("run\n--verbose\n")).toEqual(["run", "--verbose"]);
  });

  it("accepts a JSON array", () => {
    expect(parseMcpArguments('["run", "--verbose", 3]')).toEqual([
      "run",
      "--verbose",
      "3",
    ]);
  });
});

describe("parseMcpConfigJson", () => {
  it("imports Claude-style local configs", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "docker",
            args: ["run", "--rm", "mcp/github"],
            env: { GITHUB_TOKEN: "<token>", LOG_LEVEL: "debug" },
          },
        },
      }),
    );

    expect(result).toMatchObject({
      name: "github",
      serverType: "local",
      command: "docker",
      arguments: "run\n--rm\nmcp/github",
    });
    expect(result.environment).toEqual([
      expect.objectContaining({
        key: "GITHUB_TOKEN",
        type: "secret",
        promptOnInstallation: true,
      }),
      expect.objectContaining({
        key: "LOG_LEVEL",
        value: "debug",
        promptOnInstallation: false,
      }),
    ]);
  });

  it("imports VS Code servers with declared inputs", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: `Bearer \${input:github_mcp_pat}`,
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "github_mcp_pat",
            description: "GitHub token",
            password: true,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      name: "github",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      authMethod: "bearer",
      includeBearerPrefix: true,
    });
  });

  it("imports official Registry remote manifests", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        name: "com.example/acme-analytics",
        title: "ACME Analytics",
        description: "Business intelligence",
        version: "2.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://analytics.example.com/mcp",
            headers: [
              {
                name: "X-API-Key",
                description: "API key",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      name: "ACME Analytics",
      description: "Business intelligence",
      serverType: "remote",
      serverUrl: "https://analytics.example.com/mcp",
    });
    expect(result.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-API-Key",
        promptOnInstallation: true,
        sensitive: true,
      }),
    ]);
  });

  it("imports wrapped official Registry API responses", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        server: {
          name: "com.example/docs",
          title: "Docs",
          remotes: [
            {
              type: "streamable-http",
              url: "https://docs.example.com/mcp",
            },
          ],
        },
        _meta: { "io.modelcontextprotocol.registry/official": true },
      }),
    );

    expect(result).toMatchObject({
      name: "Docs",
      serverType: "remote",
      serverUrl: "https://docs.example.com/mcp",
    });
  });

  it("imports official Registry npm packages", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        name: "io.github.example/server",
        version: "1.2.3",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/mcp-server",
            version: "1.2.3",
            transport: { type: "stdio" },
            environmentVariables: [
              {
                name: "API_KEY",
                description: "Service API key",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      serverType: "local",
      command: "npx",
      arguments: "-y\n@example/mcp-server@1.2.3",
    });
    expect(result.environment[0]).toMatchObject({
      key: "API_KEY",
      type: "secret",
      required: true,
    });
  });

  it("imports Archestra manifests", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        name: "sonarqube",
        description: "SonarQube MCP",
        user_config: {
          token: {
            sensitive: true,
            required: true,
            description: "SonarQube token",
          },
        },
        server: {
          type: "local",
          command: "docker",
          args: ["run", "mcp/sonarqube"],
          env: { SONARQUBE_TOKEN: `\${user_config.token}` },
        },
      }),
    );

    expect(result).toMatchObject({
      name: "sonarqube",
      serverType: "local",
      command: "docker",
      arguments: "run\nmcp/sonarqube",
    });
    expect(result.environment[0]).toMatchObject({
      key: "SONARQUBE_TOKEN",
      type: "secret",
      promptOnInstallation: true,
      required: true,
      description: "SonarQube token",
    });
  });

  it("rejects unrelated JSON", () => {
    expect(() => parseMcpConfigJson('{"hello":"world"}')).toThrow(
      "No MCP server configuration",
    );
  });
});
