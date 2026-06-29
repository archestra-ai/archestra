import { describe, expect, it } from "vitest";
import { McpConfigParseError, parseMcpServerConfig } from "./mcp-config-parser";

describe("parseMcpServerConfig", () => {
  it("imports a standard mcpServers local server with a secret-keyed placeholder env", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "YOUR_TOKEN_HERE" },
          },
        },
      }),
    );

    expect(result.serverName).toBe("github");
    expect(result.values.name).toBe("github");
    expect(result.values.serverType).toBe("local");
    expect(result.values.localConfig?.command).toBe("npx");
    expect(result.values.localConfig?.arguments).toBe(
      "-y\n@modelcontextprotocol/server-github",
    );
    expect(result.values.localConfig?.environment).toEqual([
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        type: "secret",
        value: undefined,
        promptOnInstallation: true,
        required: true,
        description: "",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps a concrete, non-secret env value as a static plain_text default", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          t: { command: "node", args: ["s.js"], env: { LOG_LEVEL: "info" } },
        },
      }),
    );

    expect(result.values.localConfig?.environment).toEqual([
      {
        key: "LOG_LEVEL",
        type: "plain_text",
        value: "info",
        promptOnInstallation: false,
        required: false,
        description: "",
      },
    ]);
  });

  it("treats placeholder env values as prompt-on-install with no value", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          t: {
            command: "node",
            env: { A: "<token>", B: "$" + "{ENV}", C: "", D: "changeme" },
          },
        },
      }),
    );

    for (const entry of result.values.localConfig?.environment ?? []) {
      expect(entry.promptOnInstallation).toBe(true);
      expect(entry.value).toBeUndefined();
    }
  });

  it("imports the first of several servers and warns about the rest", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          a: { command: "node", args: ["a.js"] },
          b: { command: "node" },
        },
      }),
    );

    expect(result.serverName).toBe("a");
    expect(result.warnings[0]).toMatch(/Found 2 servers; imported "a"/);
  });

  it("accepts a single bare server object without the mcpServers wrapper", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({ command: "uvx", args: ["mcp-server-time"] }),
    );

    expect(result.values.serverType).toBe("local");
    expect(result.values.localConfig?.command).toBe("uvx");
    expect(result.values.localConfig?.arguments).toBe("mcp-server-time");
  });

  it("detects a remote server from its url", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({ type: "http", url: "https://api.example.com/mcp" }),
    );

    expect(result.values.serverType).toBe("remote");
    expect(result.values.serverUrl).toBe("https://api.example.com/mcp");
  });

  it("flags remote headers for manual auth setup instead of importing them", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          x: { url: "https://x/mcp", headers: { Authorization: "Bearer T" } },
        },
      }),
    );

    expect(result.values.serverType).toBe("remote");
    expect(result.values.additionalHeaders).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/header/i);
  });

  it("reuses the docker parser for a `docker run` command", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          grafana: {
            command: "docker",
            args: [
              "run",
              "-i",
              "--rm",
              "-e",
              "GF_TOKEN",
              "mcp/grafana",
              "-t",
              "stdio",
            ],
          },
        },
      }),
    );

    expect(result.values.localConfig?.dockerImage).toBe("mcp/grafana");
    expect(result.values.localConfig?.command).toBe("");
    expect(result.values.localConfig?.arguments).toBe("-t\nstdio");
  });

  it("imports an official registry npm package with a required secret env var", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        name: "io.github.foo/bar",
        description: "d",
        packages: [
          {
            registry_type: "npm",
            identifier: "@foo/bar-mcp",
            version: "1.2.3",
            transport: { type: "stdio" },
            environment_variables: [
              {
                name: "API_KEY",
                description: "key",
                is_required: true,
                is_secret: true,
              },
            ],
          },
        ],
      }),
    );

    expect(result.values.name).toBe("bar");
    expect(result.serverName).toBe("io.github.foo/bar");
    expect(result.values.serverType).toBe("local");
    expect(result.values.localConfig?.command).toBe("npx");
    expect(result.values.localConfig?.arguments).toBe("-y\n@foo/bar-mcp@1.2.3");
    expect(result.values.localConfig?.environment?.[0]).toMatchObject({
      key: "API_KEY",
      type: "secret",
      required: true,
      promptOnInstallation: true,
    });
  });

  it("maps an official registry oci package to a docker image", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        name: "x",
        packages: [
          {
            registry_type: "oci",
            identifier: "mcp/redis",
            version: "latest",
            transport: { type: "stdio" },
          },
        ],
      }),
    );

    expect(result.values.localConfig?.dockerImage).toBe("mcp/redis:latest");
  });

  it("falls back to an official registry remote when there are no packages", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        name: "x",
        remotes: [{ type: "streamable-http", url: "https://r/mcp" }],
      }),
    );

    expect(result.values.serverType).toBe("remote");
    expect(result.values.serverUrl).toBe("https://r/mcp");
  });

  it("warns when a registry package has structured runtime/package arguments", () => {
    const result = parseMcpServerConfig(
      JSON.stringify({
        name: "x",
        packages: [
          {
            registry_type: "npm",
            identifier: "p",
            package_arguments: [{ value: "--flag" }],
          },
        ],
      }),
    );

    expect(result.warnings.join(" ")).toMatch(/runtime\/package arguments/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseMcpServerConfig("{ not json")).toThrow(
      McpConfigParseError,
    );
  });

  it("throws on empty input", () => {
    expect(() => parseMcpServerConfig("   ")).toThrow(
      /Paste an MCP server configuration/,
    );
  });

  it("throws on a non-object JSON value", () => {
    expect(() => parseMcpServerConfig("[1,2,3]")).toThrow(
      /Expected a JSON object/,
    );
  });

  it("throws when the object isn't a recognizable server config", () => {
    expect(() =>
      parseMcpServerConfig(JSON.stringify({ foo: 1, bar: 2 })),
    ).toThrow(/Couldn't recognize/);
  });
});
