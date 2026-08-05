import { parseMcpConfigImport } from "./mcp-config-import-parser";

describe("parseMcpConfigImport", () => {
  it.each([
    ["empty input", "", "Paste an MCP server configuration"],
    ["invalid JSON", "{", "not valid JSON"],
    ["a JSON array", "[]", "must be a JSON object"],
    ["an unrelated object", '{"theme":"dark"}', "No MCP server configuration"],
  ])("rejects %s", (_, input, message) => {
    expect(() => parseMcpConfigImport(input)).toThrow(message);
  });

  it("imports a Claude-style local server without persisting credentials", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: {
              GITHUB_TOKEN: "ghp_concrete_secret",
              LOG_LEVEL: "debug",
              OPTIONAL_VALUE: "<value>",
            },
          },
        },
      }),
    );

    expect(candidate.values).toMatchObject({
      name: "github",
      serverType: "local",
      localConfig: {
        command: "npx",
        arguments: "-y\n@modelcontextprotocol/server-github",
        transportType: "stdio",
        environment: [
          {
            key: "GITHUB_TOKEN",
            type: "secret",
            value: undefined,
            promptOnInstallation: true,
          },
          {
            key: "LOG_LEVEL",
            type: "plain_text",
            value: "debug",
            promptOnInstallation: false,
          },
          {
            key: "OPTIONAL_VALUE",
            value: undefined,
            promptOnInstallation: true,
          },
        ],
      },
    });
  });

  it("uses VS Code input metadata for a remote bearer header", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: `Bearer \${input:github_mcp_pat}`,
              "X-Tenant": "engineering",
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "github_mcp_pat",
            description: "GitHub personal access token",
            password: true,
          },
        ],
      }),
    );

    expect(candidate.values).toMatchObject({
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      authMethod: "auth_header",
      additionalHeaders: [
        {
          fieldName: "github_mcp_pat",
          headerName: "Authorization",
          includeBearerPrefix: true,
          sensitive: true,
          promptOnInstallation: true,
          description: "GitHub personal access token",
        },
        {
          headerName: "X-Tenant",
          value: "engineering",
          promptOnInstallation: false,
        },
      ],
    });
  });

  it("never stores a concrete Authorization header value", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        service: {
          url: "https://service.example.com/mcp",
          headers: { Authorization: "Bearer concrete-token" },
        },
      }),
    );

    expect(candidate.values).toMatchObject({
      authMethod: "auth_header",
      additionalHeaders: [
        {
          headerName: "Authorization",
          value: "",
          includeBearerPrefix: true,
          sensitive: true,
          promptOnInstallation: true,
        },
      ],
    });
  });

  it("returns every server so the UI can require an explicit selection", () => {
    const candidates = parseMcpConfigImport(
      JSON.stringify({
        mcpServers: {
          alpha: { command: "alpha" },
          beta: { url: "https://beta.example.com/mcp" },
        },
      }),
    );

    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(candidates.map((candidate) => candidate.values.serverType)).toEqual([
      "local",
      "remote",
    ]);
  });

  it("imports an OpenCode command array and environment object", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        mcp: {
          context7: {
            type: "local",
            command: ["npx", "-y", "@upstash/context7-mcp"],
            environment: { CACHE_ENABLED: true },
          },
        },
      }),
    );

    expect(candidate.values.localConfig).toMatchObject({
      command: "npx",
      arguments: "-y\n@upstash/context7-mcp",
      environment: [
        {
          key: "CACHE_ENABLED",
          type: "boolean",
          value: "true",
          promptOnInstallation: false,
        },
      ],
    });
  });

  it("imports a Zed-style nested command", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        context_servers: {
          filesystem: {
            command: {
              path: "node",
              args: ["server.js", "/workspace"],
              env: { MODE: "read-only" },
            },
          },
        },
      }),
    );

    expect(candidate.values.localConfig).toMatchObject({
      command: "node",
      arguments: "server.js\n/workspace",
      environment: [{ key: "MODE", value: "read-only" }],
    });
  });

  it("converts docker run configs into Kubernetes container settings", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        sonarqube: {
          command: "docker",
          args: ["run", "-i", "--rm", "mcp/sonarqube", "--port", "8081"],
          env: { SONARQUBE_TOKEN: "<token>" },
        },
      }),
    );

    expect(candidate.values.localConfig).toMatchObject({
      command: "",
      arguments: "--port\n8081",
      dockerImage: "mcp/sonarqube",
      transportType: "streamable-http",
      httpPort: "8081",
    });
  });

  it("offers each remote and package from an official Registry entry", () => {
    const candidates = parseMcpConfigImport(
      JSON.stringify({
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "com.example/acme-analytics",
        title: "ACME Analytics",
        description: "Analytics tools",
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
        packages: [
          {
            registryType: "npm",
            identifier: "@example/analytics-mcp",
            version: "2.0.0",
            transport: { type: "stdio" },
            packageArguments: [
              { type: "positional", value: "serve" },
              {
                type: "named",
                name: "--region",
                valueHint: "region",
                isRequired: true,
              },
              {
                type: "named",
                name: "--verbose",
                isRequired: false,
              },
            ],
            environmentVariables: [
              {
                name: "API_TOKEN",
                description: "Service token",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      }),
    );

    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "ACME Analytics — remote (streamable-http)",
      "ACME Analytics — npm package",
    ]);
    expect(candidates[0].values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-API-Key",
        sensitive: true,
        promptOnInstallation: true,
      }),
    ]);
    expect(candidates[1].values.localConfig).toMatchObject({
      command: "npx",
      arguments: "-y\n@example/analytics-mcp@2.0.0\nserve\n--region\n<region>",
      environment: [
        expect.objectContaining({
          key: "API_TOKEN",
          type: "secret",
          value: undefined,
        }),
      ],
    });
    expect(candidates[1].warnings).toContain(
      "Replace the <region> argument placeholder before saving.",
    );
  });

  it("accepts legacy snake_case Registry fields", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        name: "io.example/python-server",
        packages: [
          {
            registry_type: "pypi",
            identifier: "python-mcp",
            version: "1.2.0",
            runtime_hint: "uvx",
            transport: { type: "stdio" },
            environment_variables: [
              {
                name: "LOG_LEVEL",
                default: "info",
                is_required: false,
                is_secret: false,
              },
            ],
          },
        ],
      }),
    );

    expect(candidate.values.localConfig).toMatchObject({
      command: "uvx",
      arguments: "python-mcp==1.2.0",
      environment: [
        {
          key: "LOG_LEVEL",
          value: undefined,
          default: "info",
          promptOnInstallation: true,
        },
      ],
    });
  });

  it("imports an official OCI package without duplicating its tag", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        name: "io.example/container-server",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/example/server:1.4.0",
            version: "1.4.0",
            transport: {
              type: "streamable-http",
              url: "http://localhost:9090/api/mcp",
            },
          },
        ],
      }),
    );

    expect(candidate.values.localConfig).toMatchObject({
      dockerImage: "ghcr.io/example/server:1.4.0",
      transportType: "streamable-http",
      httpPort: "9090",
      httpPath: "/api/mcp",
    });
  });

  it("unwraps official Registry API responses", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        servers: [
          {
            server: {
              name: "io.example/remote-server",
              remotes: [
                { type: "streamable-http", url: "https://mcp.example.com" },
              ],
            },
            _meta: { status: "active" },
          },
        ],
      }),
    );

    expect(candidate.values).toMatchObject({
      name: "remote-server",
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
    });
  });

  it("imports Archestra OAuth metadata but never imports its client secret", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        description: "Remote project tools",
        archestra_config: { works_in_archestra: true },
        oauth_config: {
          name: "Project Tools",
          server_url: "https://tools.example.com/mcp",
          client_id: "client-id",
          client_secret: "must-not-be-imported",
          redirect_uris: ["https://app.example.com/oauth-callback"],
          scopes: ["read", "write"],
          supports_resource_metadata: true,
        },
        server: {
          type: "remote",
          url: "https://tools.example.com/mcp",
        },
      }),
    );

    expect(candidate.values).toMatchObject({
      name: "Project Tools",
      description: "Remote project tools",
      authMethod: "oauth",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "read, write",
      },
    });
  });

  it("imports Archestra client-credentials OAuth as a machine flow", () => {
    const [candidate] = parseMcpConfigImport(
      JSON.stringify({
        oauth_config: {
          name: "Machine Tools",
          grant_type: "client_credentials",
          client_id: "machine-client",
          client_secret: "must-not-be-imported",
          token_endpoint: "https://auth.example.com/token",
        },
        server: {
          type: "remote",
          url: "https://tools.example.com/mcp",
        },
      }),
    );

    expect(candidate.values).toMatchObject({
      authMethod: "oauth_client_credentials",
      oauthConfig: {
        grantType: "client_credentials",
        client_id: "machine-client",
        client_secret: "",
        tokenEndpoint: "https://auth.example.com/token",
      },
    });
    expect(candidate.warnings).not.toContain(
      "Add the OAuth callback URL before saving.",
    );
  });
});
