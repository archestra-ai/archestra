// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${input:...} and ${user_config.*} are literal placeholder tokens this parser must recognize, not JS template strings.
import { parseMcpServerConfig } from "./mcp-config-paste-parser";

describe("parseMcpServerConfig", () => {
  it("returns null for empty or invalid JSON", () => {
    expect(parseMcpServerConfig("")).toBeNull();
    expect(parseMcpServerConfig("   ")).toBeNull();
    expect(parseMcpServerConfig("not json")).toBeNull();
    expect(parseMcpServerConfig("[1,2,3]")).toBeNull();
    expect(parseMcpServerConfig("42")).toBeNull();
  });

  it("handles a large pasted env value quickly (no catastrophic backtracking)", () => {
    const huge = "a".repeat(200_000);
    const raw = JSON.stringify({
      mcpServers: { x: { command: "npx", args: [], env: { DATA: huge } } },
    });
    const start = performance.now();
    const result = parseMcpServerConfig(raw);
    const elapsed = performance.now() - start;
    expect(result?.values.localConfig?.environment?.[0]).toMatchObject({
      key: "DATA",
      type: "plain_text",
      promptOnInstallation: false,
    });
    expect(elapsed).toBeLessThan(1000);
  });

  describe("VS Code / Copilot format", () => {
    it("maps ${input:id} refs in headers to prompted secret headers", () => {
      const raw = JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer ${input:github_mcp_pat}",
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "github_mcp_pat",
            description: "GitHub Personal Access Token",
            password: true,
          },
        ],
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("vscode");
      expect(result?.values.serverType).toBe("remote");
      expect(result?.values.serverUrl).toBe(
        "https://api.githubcopilot.com/mcp/",
      );

      const header = result?.values.additionalHeaders?.[0];
      expect(header).toMatchObject({
        headerName: "Authorization",
        value: "",
        promptOnInstallation: true,
        required: true,
        sensitive: true,
        includeBearerPrefix: true,
        description: "GitHub Personal Access Token",
      });

      expect(result?.detectedUserInputs).toContainEqual(
        expect.objectContaining({
          source: "header",
          key: "Authorization",
          sensitive: true,
          required: true,
        }),
      );
    });

    it("maps ${input:id} refs in env to prompted env vars on a local server", () => {
      const raw = JSON.stringify({
        servers: {
          local: {
            command: "npx",
            args: ["-y", "some-mcp"],
            env: { API_TOKEN: "${input:tok}" },
          },
        },
        inputs: [{ type: "promptString", id: "tok", description: "API token" }],
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("vscode");
      expect(result?.values.serverType).toBe("local");
      expect(result?.values.localConfig?.command).toBe("npx");
      expect(result?.values.localConfig?.arguments).toBe("-y\nsome-mcp");

      const env = result?.values.localConfig?.environment?.[0];
      expect(env).toMatchObject({
        key: "API_TOKEN",
        type: "secret",
        value: "",
        promptOnInstallation: true,
        required: true,
        description: "API token",
      });
    });
  });

  describe("Claude Desktop / Smithery format", () => {
    it("converts <placeholder> env values into required secret fields", () => {
      const raw = JSON.stringify({
        mcpServers: {
          sonarqube: {
            command: "docker",
            args: [
              "run",
              "--init",
              "-i",
              "--rm",
              "-e",
              "SONARQUBE_TOKEN",
              "mcp/sonarqube",
            ],
            env: {
              SONARQUBE_TOKEN: "<token>",
              SONARQUBE_ORG: "<org>",
            },
          },
        },
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("claude_desktop");
      expect(result?.values.serverType).toBe("local");
      // `docker run ... image` with no trailing command -> image's default CMD,
      // so command is empty and the image is extracted (matches the K8s runtime
      // model used by transformExternalCatalogToFormValues).
      expect(result?.values.localConfig?.command).toBe("");
      expect(result?.values.localConfig?.dockerImage).toBe("mcp/sonarqube");
      expect(result?.serverName).toBe("sonarqube");

      const env = result?.values.localConfig?.environment ?? [];
      const token = env.find((e) => e.key === "SONARQUBE_TOKEN");
      expect(token).toMatchObject({
        type: "secret",
        value: "",
        promptOnInstallation: true,
        required: true,
      });
      const org = env.find((e) => e.key === "SONARQUBE_ORG");
      // ORG is a placeholder but not a secret-named key -> plain_text, still prompted.
      expect(org).toMatchObject({
        type: "plain_text",
        value: "",
        promptOnInstallation: true,
        required: true,
      });
    });

    it("keeps concrete (non-placeholder) env values as plain text without prompting", () => {
      const raw = JSON.stringify({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { LOG_LEVEL: "debug" },
          },
        },
      });

      const result = parseMcpServerConfig(raw);
      const env = result?.values.localConfig?.environment?.[0];
      expect(env).toMatchObject({
        key: "LOG_LEVEL",
        type: "plain_text",
        value: "debug",
        promptOnInstallation: false,
        required: false,
      });
      expect(result?.detectedUserInputs).toHaveLength(0);
    });

    it("masks a concrete secret-named env value as secret without prompting", () => {
      const raw = JSON.stringify({
        mcpServers: {
          gh: {
            command: "npx",
            args: ["-y", "github-mcp"],
            env: { GITHUB_TOKEN: "ghp_concretevalue123" },
          },
        },
      });
      const env =
        parseMcpServerConfig(raw)?.values.localConfig?.environment?.[0];
      expect(env).toMatchObject({
        key: "GITHUB_TOKEN",
        type: "secret",
        value: "ghp_concretevalue123",
        promptOnInstallation: false,
        required: false,
      });
    });

    it("reports the total server count when multiple servers are pasted", () => {
      const raw = JSON.stringify({
        mcpServers: {
          first: { command: "npx", args: ["-y", "a"] },
          second: { command: "npx", args: ["-y", "b"] },
        },
      });
      const result = parseMcpServerConfig(raw);
      expect(result?.serverCount).toBe(2);
      // The first server is the one imported.
      expect(result?.serverName).toBe("first");
      expect(result?.values.localConfig?.arguments).toBe("-y\na");
    });

    it("parses a bare single-server object", () => {
      const raw = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "YOUR_TOKEN_HERE" },
      });
      const result = parseMcpServerConfig(raw);
      expect(result?.values.serverType).toBe("local");
      expect(result?.values.localConfig?.command).toBe("node");
      expect(result?.values.localConfig?.environment?.[0]).toMatchObject({
        key: "TOKEN",
        type: "secret",
        promptOnInstallation: true,
        required: true,
      });
    });

    it("parses a bare name->server map without a wrapper key", () => {
      const raw = JSON.stringify({
        sonarqube: {
          command: "docker",
          args: ["run", "-i", "--rm", "mcp/sonarqube"],
          env: { SONARQUBE_TOKEN: "<token>" },
        },
      });
      const result = parseMcpServerConfig(raw);
      expect(result?.values.serverType).toBe("local");
      expect(result?.values.localConfig?.dockerImage).toBe("mcp/sonarqube");
      expect(result?.serverName).toBe("sonarqube");
    });

    it("maps a remote url server to remote serverType", () => {
      const raw = JSON.stringify({
        mcpServers: {
          remote: { url: "https://mcp.example.com/sse", type: "sse" },
        },
      });
      const result = parseMcpServerConfig(raw);
      expect(result?.values.serverType).toBe("remote");
      expect(result?.values.serverUrl).toBe("https://mcp.example.com/sse");
    });
  });

  describe("Official MCP registry format", () => {
    it("builds a local npx server from a npm package entry", () => {
      const raw = JSON.stringify({
        name: "io.github.example/weather",
        description: "Weather MCP",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/weather-mcp",
            version: "1.2.0",
            environmentVariables: [
              {
                name: "WEATHER_API_KEY",
                description: "API key",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("mcp_registry");
      expect(result?.values.serverType).toBe("local");
      expect(result?.values.localConfig?.command).toBe("npx");
      expect(result?.values.localConfig?.arguments).toBe(
        "-y\n@example/weather-mcp@1.2.0",
      );
      expect(result?.values.name).toBe("io.github.example/weather");

      const env = result?.values.localConfig?.environment?.[0];
      expect(env).toMatchObject({
        key: "WEATHER_API_KEY",
        type: "secret",
        promptOnInstallation: true,
        required: true,
      });
    });

    it("builds a remote server from a remotes entry", () => {
      const raw = JSON.stringify({
        name: "io.github.example/remote",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.com/mcp",
            headers: [{ name: "X-Api-Key", isRequired: true, isSecret: true }],
          },
        ],
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("mcp_registry");
      expect(result?.values.serverType).toBe("remote");
      expect(result?.values.serverUrl).toBe("https://mcp.example.com/mcp");
      expect(result?.values.additionalHeaders?.[0]).toMatchObject({
        headerName: "X-Api-Key",
        promptOnInstallation: true,
        required: true,
        sensitive: true,
      });
    });

    it("builds a docker server from an oci package entry", () => {
      const raw = JSON.stringify({
        name: "io.github.example/dockerized",
        packages: [
          {
            registryType: "oci",
            identifier: "example/mcp-server:latest",
          },
        ],
      });
      const result = parseMcpServerConfig(raw);
      expect(result?.values.localConfig?.command).toBe("docker");
      expect(result?.values.localConfig?.dockerImage).toBe(
        "example/mcp-server:latest",
      );
    });
  });

  describe("Archestra manifest format", () => {
    it("delegates to the external-catalog transform for local manifests", () => {
      const raw = JSON.stringify({
        name: "atlassian",
        display_name: "Atlassian",
        description: "Atlassian MCP",
        user_config: {
          jira_token: {
            type: "string",
            title: "Jira Token",
            description: "Your Jira API token",
            required: true,
            sensitive: true,
          },
        },
        server: {
          type: "local",
          command: "npx",
          args: ["-y", "mcp-atlassian"],
          env: { JIRA_TOKEN: "${user_config.jira_token}" },
        },
      });

      const result = parseMcpServerConfig(raw);
      expect(result?.format).toBe("archestra");
      expect(result?.values.serverType).toBe("local");
      expect(result?.values.localConfig?.command).toBe("npx");

      const env = result?.values.localConfig?.environment?.find(
        (e) => e.key === "JIRA_TOKEN",
      );
      expect(env).toMatchObject({
        type: "secret",
        promptOnInstallation: true,
        required: true,
      });
    });
  });
});
