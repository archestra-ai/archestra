import { describe, expect, test } from "vitest";
import { DeviceMcpConfigSchema } from "./device-mcp";

const config = {
  protocolVersion: 1,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["server.mjs"] },
    win32: { command: "node.exe", args: ["C:/server.mjs"] },
  },
  tools: [
    {
      name: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
};

describe("device MCP launch contract", () => {
  test("preserves platform arguments and reviewed tool schema", () => {
    expect(DeviceMcpConfigSchema.parse(config)).toEqual(config);
  });
  test("rejects missing platform support, incompatible protocols and unknown launch options", () => {
    expect(
      DeviceMcpConfigSchema.safeParse({
        ...config,
        platforms: { darwin: config.platforms.darwin },
      }).success,
    ).toBe(false);
    expect(
      DeviceMcpConfigSchema.safeParse({ ...config, protocolVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      DeviceMcpConfigSchema.safeParse({
        ...config,
        platforms: {
          ...config.platforms,
          darwin: { ...config.platforms.darwin, shell: true },
        },
      }).success,
    ).toBe(false);
  });
  test("rejects ambiguous tool names, non-object input schemas and script-shaped executables", () => {
    expect(
      DeviceMcpConfigSchema.safeParse({
        ...config,
        tools: [...config.tools, ...config.tools],
      }).success,
    ).toBe(false);
    expect(
      DeviceMcpConfigSchema.safeParse({
        ...config,
        tools: [{ name: "echo", inputSchema: { type: "string" } }],
      }).success,
    ).toBe(false);
    expect(
      DeviceMcpConfigSchema.safeParse({
        ...config,
        platforms: {
          ...config.platforms,
          darwin: { command: "node\nserver.mjs", args: [] },
        },
      }).success,
    ).toBe(false);
  });
});
