import { describe, expect, test } from "vitest";
import { parseMcpJsonInput } from "./mcp-json-config-parser";

describe("parseMcpJsonInput", () => {
  test("returns null for plain one-per-line arguments", () => {
    expect(parseMcpJsonInput("/path/to/server.js\n--verbose")).toBeNull();
    expect(parseMcpJsonInput("not json")).toBeNull();
    expect(parseMcpJsonInput("")).toBeNull();
  });

  test("parses Claude Desktop / VS Code servers wrapper (local)", () => {
    const raw = JSON.stringify({
      servers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: {
            DEBUG: "1",
          },
        },
      },
    });

    expect(parseMcpJsonInput(raw)).toEqual({
      name: "filesystem",
      serverType: "local",
      command: "npx",
      arguments: "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
      environment: [
        {
          key: "DEBUG",
          type: "plain_text",
          value: "1",
          promptOnInstallation: false,
          required: false,
        },
      ],
    });
  });

  test("parses mcpServers alias wrapper", () => {
    const raw = JSON.stringify({
      mcpServers: {
        demo: {
          command: "node",
          args: ["server.js"],
        },
      },
    });
    expect(parseMcpJsonInput(raw)).toMatchObject({
      name: "demo",
      serverType: "local",
      command: "node",
      arguments: "server.js",
    });
  });

  test("parses bare single-server local config", () => {
    const raw = JSON.stringify({
      command: "uvx",
      args: ["mcp-server-git"],
      env: {
        GITHUB_TOKEN: "<token>",
      },
    });
    expect(parseMcpJsonInput(raw)).toEqual({
      serverType: "local",
      command: "uvx",
      arguments: "mcp-server-git",
      environment: [
        {
          key: "GITHUB_TOKEN",
          type: "secret",
          value: undefined,
          promptOnInstallation: true,
          required: true,
        },
      ],
    });
  });

  test("parses named map without servers wrapper", () => {
    const raw = JSON.stringify({
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
    });

    const parsed = parseMcpJsonInput(raw);
    expect(parsed).toMatchObject({
      name: "sonarqube",
      serverType: "local",
      dockerImage: "mcp/sonarqube",
    });
    // docker CLI flags stripped; image becomes dockerImage
    expect(parsed?.command).toBeUndefined();
    expect(parsed?.environment?.map((e) => e.key).sort()).toEqual([
      "SONARQUBE_ORG",
      "SONARQUBE_TOKEN",
    ]);
    expect(
      parsed?.environment?.every((e) => e.promptOnInstallation === true),
    ).toBe(true);
  });

  test("parses remote http server with headers + input placeholders", () => {
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

    expect(parseMcpJsonInput(raw)).toEqual({
      name: "github",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      transportType: "streamable-http",
      headers: [
        {
          headerName: "Authorization",
          value: undefined,
          promptOnInstallation: true,
          required: true,
          sensitive: true,
          includeBearerPrefix: true,
        },
      ],
    });
  });

  test("parses dockerImage field directly", () => {
    const raw = JSON.stringify({
      dockerImage: "mcp/grafana",
      arguments: ["-t", "stdio"],
      transportType: "stdio",
    });
    expect(parseMcpJsonInput(raw)).toMatchObject({
      serverType: "local",
      dockerImage: "mcp/grafana",
      arguments: "-t\nstdio",
      transportType: "stdio",
    });
  });

  test("parses docker run with container command override", () => {
    const raw = JSON.stringify({
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
    expect(parseMcpJsonInput(raw)).toEqual({
      serverType: "local",
      dockerImage: "pulumi/mcp-server:latest",
      command: "npx",
      arguments: "-y\npulumi-mcp",
    });
  });

  test("returns null for empty object / unrelated JSON", () => {
    expect(parseMcpJsonInput("{}")).toBeNull();
    expect(parseMcpJsonInput('{"foo":"bar"}')).toBeNull();
    expect(parseMcpJsonInput("[1,2,3]")).toBeNull();
  });
});
