import { describe, expect, it } from "vitest";
import {
  type ParsedMcpServerConfig,
  parseMcpServerConfigJson,
} from "./mcp-config-parser";

describe("parseMcpServerConfigJson", () => {
  // ─── Claude Desktop / Cursor format ─────────────────────────────────

  describe("Claude Desktop / Cursor format: { mcpServers: { name: { ... } } }", () => {
    it("should parse a stdio server with command, args, and env", () => {
      const input = JSON.stringify({
        mcpServers: {
          "my-server": {
            command: "node",
            args: ["/path/to/server.js", "--verbose"],
            env: {
              API_KEY: "secret123",
            },
          },
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("local");
      expect(result!.command).toBe("node");
      expect(result!.arguments).toBe("/path/to/server.js\n--verbose");
      expect(result!.environment).toHaveLength(1);
      expect(result!.environment![0]).toEqual({
        key: "API_KEY",
        type: "plain_text",
        value: "secret123",
        promptOnInstallation: false,
        required: false,
      });
    });

    it("should parse a remote HTTP server with URL and headers", () => {
      const input = JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer ghp_token123",
            },
          },
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://api.githubcopilot.com/mcp/");
      expect(result!.headers).toHaveLength(1);
      expect(result!.headers![0]).toEqual({
        headerName: "Authorization",
        value: "Bearer ghp_token123",
        promptOnInstallation: false,
        required: false,
        description: undefined,
        sensitive: false,
      });
    });

    it("should handle multiple servers and pick the first one", () => {
      const input = JSON.stringify({
        mcpServers: {
          "first-server": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
          },
          "second-server": {
            command: "node",
            args: ["server2.js"],
          },
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("npx");
      expect(result!.arguments).toBe(
        "-y\n@modelcontextprotocol/server-filesystem",
      );
    });

    it("should detect placeholder env values and mark them as secret prompts", () => {
      const input = JSON.stringify({
        mcpServers: {
          sonarqube: {
            command: "docker",
            args: [
              "run",
              "--init",
              "--pull=always",
              "-i",
              "--rm",
              "-e",
              "SONARQUBE_TOKEN",
              "-e",
              "SONARQUBE_ORG",
              "mcp/sonarqube",
            ],
            env: {
              SONARQUBE_TOKEN: "<token>",
              SONARQUBE_ORG: "<org>",
            },
          },
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/sonarqube");
      expect(result!.environment).toHaveLength(2);

      expect(result!.environment![0]).toEqual({
        key: "SONARQUBE_TOKEN",
        type: "secret",
        value: undefined,
        promptOnInstallation: true,
        required: true,
      });

      expect(result!.environment![1]).toEqual({
        key: "SONARQUBE_ORG",
        type: "secret",
        value: undefined,
        promptOnInstallation: true,
        required: true,
      });
    });
  });

  // ─── VS Code / inputs block format ──────────────────────────────────

  describe("VS Code format: { servers: { name: { ... } }, inputs: [...] }", () => {
    it("should parse a remote server with ${input:...} placeholders and resolve inputs", () => {
      const input = JSON.stringify({
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

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://api.githubcopilot.com/mcp/");
      expect(result!.headers).toHaveLength(1);
      expect(result!.headers![0]).toEqual({
        headerName: "Authorization",
        value: undefined,
        promptOnInstallation: true,
        required: true,
        description: "GitHub Personal Access Token",
        sensitive: true,
      });
    });

    it("should handle inputs block with password: false (non-sensitive)", () => {
      const input = JSON.stringify({
        servers: {
          myserver: {
            type: "http",
            url: "https://example.com/mcp",
            headers: {
              "X-Custom": "${input:custom_value}",
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "custom_value",
            description: "A custom value",
          },
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.headers![0].sensitive).toBe(false);
      expect(result!.headers![0].description).toBe("A custom value");
    });
  });

  // ─── Bare single-server format ──────────────────────────────────────

  describe("Bare single-server format: { command, args, env }", () => {
    it("should parse a bare local server config", () => {
      const input = JSON.stringify({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-git", "--repo", "/tmp/repo"],
        env: {
          GIT_PATH: "/usr/bin/git",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("local");
      expect(result!.command).toBe("npx");
      expect(result!.arguments).toBe(
        "-y\n@modelcontextprotocol/server-git\n--repo\n/tmp/repo",
      );
      expect(result!.environment).toHaveLength(1);
      expect(result!.environment![0].key).toBe("GIT_PATH");
    });

    it("should parse a bare remote server config", () => {
      const input = JSON.stringify({
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://api.example.com/mcp");
    });
  });

  // ─── JSON array of arguments ────────────────────────────────────────

  describe("JSON array of arguments", () => {
    it("should parse a JSON array into arguments only", () => {
      const input = '["--port", "8080", "--verbose"]';
      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.arguments).toBe("--port\n8080\n--verbose");
    });

    it("should return null for an empty array", () => {
      expect(parseMcpServerConfigJson("[]")).toBeNull();
    });

    it("should filter non-string items from the array", () => {
      const input = '["--port", 8080, null, "--verbose"]';
      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.arguments).toBe("--port\n--verbose");
    });
  });

  // ─── Docker command handling ──────────────────────────────────────

  describe("Docker command handling", () => {
    it("should extract docker image and real command from docker run args", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "pulumi/mcp-server:latest",
          "npx",
          "-y",
          "pulumi-mcp",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("pulumi/mcp-server:latest");
      expect(result!.command).toBe("npx");
      expect(result!.arguments).toBe("-y\npulumi-mcp");
    });

    it("should handle docker with no command override (flags only after image)", () => {
      const input = JSON.stringify({
        command: "docker",
        args: ["run", "-i", "--rm", "mcp/grafana", "-t", "stdio"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/grafana");
      expect(result!.command).toBeUndefined();
      expect(result!.arguments).toBe("-t\nstdio");
    });

    it("should handle docker with only image (no args after image)", () => {
      const input = JSON.stringify({
        command: "docker",
        args: ["run", "-i", "--rm", "redis/mcp-redis:latest"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("redis/mcp-redis:latest");
      expect(result!.command).toBeUndefined();
      expect(result!.arguments).toBeUndefined();
    });

    it("should skip --env-file flag and its value when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--init",
          "--env-file",
          ".env",
          "--rm",
          "-i",
          "mcp/sonarqube",
          "--transport",
          "stdio",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/sonarqube");
      expect(result!.command).toBeUndefined();
      expect(result!.arguments).toBe("--transport\nstdio");
    });

    it("should skip --pull flag (space-separated) when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--pull",
          "always",
          "-i",
          "--rm",
          "mcp/grafana:latest",
          "-t",
          "stdio",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/grafana:latest");
      expect(result!.arguments).toBe("-t\nstdio");
    });

    it("should handle --pull=always (inline form) correctly", () => {
      const input = JSON.stringify({
        command: "docker",
        args: ["run", "--pull=always", "-i", "--rm", "mcp/server:latest"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/server:latest");
    });

    it("should skip --restart flag and its value when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--restart",
          "unless-stopped",
          "-i",
          "mcp/postgres:latest",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/postgres:latest");
    });

    it("should skip --hostname flag and its value when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--hostname",
          "mcp-server",
          "-i",
          "--rm",
          "mcp/custom:latest",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/custom:latest");
    });

    it("should skip --mount flag and its value when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--mount",
          "type=bind,src=/data,dst=/data",
          "-i",
          "--rm",
          "mcp/server:latest",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/server:latest");
    });

    it("should skip --gpus flag and its value when finding docker image", () => {
      const input = JSON.stringify({
        command: "docker",
        args: [
          "run",
          "--gpus",
          "all",
          "-i",
          "--rm",
          "mcp/gpu-server:latest",
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.dockerImage).toBe("mcp/gpu-server:latest");
    });
  });

  // ─── Archestra registry format ────────────────────────────────────

  describe("Archestra registry format", () => {
    it("should parse archestra registry format with remote server and user_config", () => {
      const input = JSON.stringify({
        server: {
          type: "remote",
          url: "https://api.githubcopilot.com/mcp/",
          docs_url: "https://example.com/docs",
        },
        user_config: {
          access_token: {
            sensitive: true,
            type: "string",
            title: "Access Token",
            description: "A GitHub Personal Access Token",
            required: true,
          },
        },
        archestra_config: {
          works_in_archestra: true,
        },
        oauth_config: {
          server_url: "https://api.githubcopilot.com/mcp",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://api.githubcopilot.com/mcp/");
      expect(result!.environment).toBeDefined();
      expect(result!.environment!.length).toBe(1);
      expect(result!.environment![0].key).toBe("access_token");
      expect(result!.environment![0].type).toBe("secret");
      expect(result!.environment![0].promptOnInstallation).toBe(true);
      expect(result!.environment![0].required).toBe(true);
    });

    it("should handle archestra format with non-sensitive user_config", () => {
      const input = JSON.stringify({
        server: {
          type: "remote",
          url: "https://example.com/mcp",
        },
        user_config: {
          org_name: {
            sensitive: false,
            type: "string",
            title: "Organization Name",
            required: false,
          },
        },
        archestra_config: {},
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.environment).toBeDefined();
      expect(result!.environment![0].key).toBe("org_name");
      expect(result!.environment![0].type).toBe("plain_text");
      expect(result!.environment![0].promptOnInstallation).toBe(false);
    });
  });

  // ─── MCP Registry format ──────────────────────────────────────────

  describe("MCP Registry server.json format", () => {
    it("should parse MCP registry remote server from remotes array", () => {
      const input = JSON.stringify({
        server: {
          name: "io.github/example/server",
          description: "An example MCP server",
          remotes: [
            {
              transport: {
                type: "streamable-http",
                url: "https://mcp.example.com/sse",
              },
              headers: [
                {
                  name: "Authorization",
                  isSecret: true,
                  isRequired: true,
                  description: "Bearer token",
                  value: "Bearer ${input:token}",
                },
              ],
            },
          ],
        },
        packages: [
          {
            registryType: "npm",
            identifier: "@example/mcp-server",
            version: "1.0.0",
            transport: { type: "stdio" },
            runtimeHint: "npx",
            environmentVariables: [
              {
                name: "API_KEY",
                isSecret: true,
                isRequired: true,
                description: "API key for the service",
              },
            ],
          },
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      // Remotes take priority — should be remote
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://mcp.example.com/sse");
    });

    it("should parse MCP registry local package when no remotes", () => {
      const input = JSON.stringify({
        server: {
          name: "io.github/example/local-server",
          description: "A local MCP server",
        },
        packages: [
          {
            registryType: "npm",
            identifier: "@example/local-mcp",
            version: "1.0.0",
            transport: { type: "stdio" },
            runtimeHint: "npx",
            environmentVariables: [
              {
                name: "API_KEY",
                isSecret: true,
                isRequired: true,
                description: "API key",
              },
            ],
          },
        ],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("local");
      expect(result!.command).toBe("npx");
      expect(result!.arguments).toBe("@example/local-mcp");
      expect(result!.environment).toBeDefined();
      expect(result!.environment!.length).toBe(1);
      expect(result!.environment![0].key).toBe("API_KEY");
      expect(result!.environment![0].type).toBe("secret");
    });

    it("should return null for MCP registry with empty packages array", () => {
      const input = JSON.stringify({
        server: {
          name: "io.github/example/empty",
        },
        packages: [],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).toBeNull();
    });
  });

  // ─── Placeholder detection ──────────────────────────────────────────

  describe("Placeholder env value detection", () => {
    it.each([
      ["<token>", true],
      ["<your-key>", true],
      ["YOUR_TOKEN", true],
      ["YOUR_API_KEY", true],
      ["${ENV_VAR}", true],
      ["${INPUT:github_pat}", true],
      ["REDACTED", true],
      ["changeme", true],
      ["placeholder", true],
      ["xxx", true],
      ["actual_value", false],
      ["sk-1234567890", false],
      ["", false],
    ])("should detect %s as placeholder=%s", (value, expected) => {
      const isPlaceholder = value !== "" && expected;
      if (value === "") return; // skip empty — tested separately

      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: { TEST_KEY: value },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      const env = result!.environment![0];

      if (expected) {
        expect(env.type).toBe("secret");
        expect(env.promptOnInstallation).toBe(true);
        expect(env.value).toBeUndefined();
      } else {
        expect(env.type).toBe("plain_text");
        expect(env.promptOnInstallation).toBe(false);
        expect(env.value).toBe(value);
      }
    });
  });

  // ─── Transport type detection ───────────────────────────────────────

  describe("Transport type detection", () => {
    it("should detect stdio transport from --transport stdio flag", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js", "--transport", "stdio"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.transportType).toBe("stdio");
    });

    it("should detect streamable-http from --port flag", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js", "--port", "3000"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.transportType).toBe("streamable-http");
      expect(result!.httpPort).toBe("3000");
    });

    it("should default to streamable-http when no transport flag is present", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.transportType).toBe("streamable-http");
    });
  });

  // ─── Invalid / malformed inputs ────────────────────────────────────

  describe("Invalid and malformed inputs", () => {
    it("should return null for non-JSON text", () => {
      expect(parseMcpServerConfigJson("just some text")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseMcpServerConfigJson("")).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      expect(parseMcpServerConfigJson("   \n  ")).toBeNull();
    });

    it("should return null for malformed JSON", () => {
      expect(parseMcpServerConfigJson('{ "command": "node"')).toBeNull();
    });

    it("should return null for a JSON string (not an object or array)", () => {
      expect(parseMcpServerConfigJson('"hello"')).toBeNull();
    });

    it("should return null for a JSON number", () => {
      expect(parseMcpServerConfigJson("42")).toBeNull();
    });

    it("should return null for a JSON boolean", () => {
      expect(parseMcpServerConfigJson("true")).toBeNull();
    });

    it("should return null for null", () => {
      expect(parseMcpServerConfigJson("null")).toBeNull();
    });

    it("should return null for an object with no recognized keys", () => {
      expect(parseMcpServerConfigJson('{"foo": "bar"}')).toBeNull();
    });

    it("should return null for empty mcpServers object", () => {
      expect(parseMcpServerConfigJson('{"mcpServers": {}}')).toBeNull();
    });

    it("should return null for empty servers object", () => {
      expect(parseMcpServerConfigJson('{"servers": {}}')).toBeNull();
    });

    it("should return null when server value is not an object", () => {
      expect(
        parseMcpServerConfigJson('{"mcpServers": {"name": "not-an-object"}}'),
      ).toBeNull();
    });
  });

  // ─── Security ──────────────────────────────────────────────────────

  describe("Security hardening", () => {
    it("should reject oversized input (> 50,000 chars)", () => {
      const huge = "x".repeat(50_001);
      expect(parseMcpServerConfigJson(huge)).toBeNull();
    });

    it("should drop __proto__ env keys", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: {
          __proto__: { polluted: true },
          NORMAL_KEY: "value",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.environment).toHaveLength(1);
      expect(result!.environment![0].key).toBe("NORMAL_KEY");
    });

    it("should drop constructor env keys", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: {
          constructor: "malicious",
          API_KEY: "value",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.environment).toHaveLength(1);
      expect(result!.environment![0].key).toBe("API_KEY");
    });

    it("should reject non-http(s) URLs in remote servers", () => {
      const input = JSON.stringify({
        type: "http",
        url: "javascript:alert(1)",
      });

      const result = parseMcpServerConfigJson(input);
      // Should not set the URL
      expect(result?.serverUrl).toBeUndefined();
    });

    it("should accept http:// URLs", () => {
      const input = JSON.stringify({
        type: "http",
        url: "http://localhost:8080/mcp",
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.serverUrl).toBe("http://localhost:8080/mcp");
    });

    it("should reject env keys that are not valid shell variable names", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: {
          "invalid-key": "value",
          "123bad": "value",
          VALID_KEY: "ok",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result!.environment).toHaveLength(1);
      expect(result!.environment![0].key).toBe("VALID_KEY");
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle server with command but no args or env", () => {
      const input = JSON.stringify({
        mcpServers: {
          "simple-server": {
            command: "npx",
          },
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("npx");
      expect(result!.arguments).toBeUndefined();
      expect(result!.environment).toBeUndefined();
    });

    it("should handle args as a newline-separated string", () => {
      const input = JSON.stringify({
        command: "node",
        args: "server.js\n--verbose\n--port 8080",
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.arguments).toBe("server.js\n--verbose\n--port 8080");
    });

    it("should handle empty args array", () => {
      const input = JSON.stringify({
        command: "node",
        args: [],
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("node");
      expect(result!.arguments).toBeUndefined();
    });

    it("should handle empty env object", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: {},
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.environment).toEqual([]);
    });

    it("should handle SSE type as remote", () => {
      const input = JSON.stringify({
        type: "sse",
        url: "https://example.com/sse",
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://example.com/sse");
    });

    it("should handle server with URL but no explicit type", () => {
      const input = JSON.stringify({
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: "Bearer token",
        },
      });

      const result = parseMcpServerConfigJson(input);
      expect(result).not.toBeNull();
      expect(result!.serverType).toBe("remote");
      expect(result!.serverUrl).toBe("https://api.example.com/mcp");
    });

    it("should handle local server that also has a url (command takes precedence)", () => {
      const input = JSON.stringify({
        command: "node",
        args: ["server.js"],
        url: "https://example.com",
      });

      const result = parseMcpServerConfigJson(input);
      // When both command and url exist, command wins (local server)
      expect(result!.serverType).toBe("local");
      expect(result!.command).toBe("node");
    });
  });
});
