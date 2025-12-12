import { describe, expect, it } from "vitest";
import { parseDockerArgsToLocalConfig } from "./docker-args-parser";

describe("parseDockerArgsToLocalConfig", () => {
  it("should parse Docker command with custom command override", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      [
        "run",
        "-i",
        "--rm",
        "pulumi/mcp-server:latest",
        "npx",
        "-y",
        "pulumi-mcp",
      ],
      "pulumi/mcp-server:latest",
    );

    expect(result).toEqual({
      command: "npx",
      arguments: ["-y", "pulumi-mcp"],
      dockerImage: "pulumi/mcp-server:latest",
    });
  });

  it("should parse Docker command with flags as arguments (no command override)", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "mcp/grafana", "-t", "stdio"],
      "mcp/grafana",
    );

    expect(result).toEqual({
      arguments: ["-t", "stdio"],
      dockerImage: "mcp/grafana",
    });
  });

  it("should handle Docker image with no args (use image default CMD)", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "redis/mcp-redis:latest"],
      "redis/mcp-redis:latest",
    );

    expect(result).toEqual({
      dockerImage: "redis/mcp-redis:latest",
    });
  });

  it("should handle Docker image not found in args", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "some-other-image"],
      "mcp/grafana",
    );

    expect(result).toEqual({
      dockerImage: "mcp/grafana",
    });
  });

  it("should return null for non-Docker commands", () => {
    const result = parseDockerArgsToLocalConfig(
      "npx",
      ["-y", "@modelcontextprotocol/server"],
      undefined,
    );

    expect(result).toBeNull();
  });

  it("should return null when no docker_image is provided", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "some-image"],
      undefined,
    );

    expect(result).toBeNull();
  });

  it("should handle empty args array", () => {
    const result = parseDockerArgsToLocalConfig("docker", [], "mcp/grafana");

    expect(result).toEqual({
      dockerImage: "mcp/grafana",
    });
  });

  it("should handle undefined args", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      undefined,
      "mcp/grafana",
    );

    expect(result).toEqual({
      dockerImage: "mcp/grafana",
    });
  });

  it("should parse complex flag arguments", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "mcp/grafana", "--debug", "--transport", "sse"],
      "mcp/grafana",
    );

    expect(result).toEqual({
      arguments: ["--debug", "--transport", "sse"],
      dockerImage: "mcp/grafana",
    });
  });

  it("should handle command with single flag argument", () => {
    const result = parseDockerArgsToLocalConfig(
      "docker",
      ["run", "-i", "--rm", "mcp/grafana", "--help"],
      "mcp/grafana",
    );

    expect(result).toEqual({
      arguments: ["--help"],
      dockerImage: "mcp/grafana",
    });
  });
});
