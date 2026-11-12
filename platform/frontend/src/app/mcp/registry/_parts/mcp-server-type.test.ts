// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  mcpServerTypeLabel,
  mcpServerVariant,
  runsInEnvironment,
  usesInstallations,
} from "./mcp-server-type";

describe("mcpServerVariant", () => {
  it.each([
    ["builtin", "builtin"],
    ["remote", "remote"],
    ["local", "local"],
    ["desktop_mcp", "desktop"],
  ] as const)("shows a %s server as %s", (serverType, variant) => {
    expect(mcpServerVariant(serverType)).toBe(variant);
  });

  it("keeps a desktop MCP server out of the self-hosted default", () => {
    // Self-hosted is where every other type lands, and it brings pods, logs,
    // deployment YAML and restarts with it.
    expect(mcpServerVariant("desktop_mcp")).not.toBe("local");
    expect(mcpServerVariant("desktop_mcp")).not.toBe("remote");
  });
});

describe("mcpServerTypeLabel", () => {
  it.each([
    ["remote", "Remote"],
    ["local", "Self-hosted"],
    ["builtin", "Built-in"],
    ["desktop_mcp", "Desktop MCP"],
  ] as const)("names a %s server %s", (serverType, label) => {
    expect(mcpServerTypeLabel(serverType)).toBe(label);
  });
});

describe("usesInstallations", () => {
  it.each([
    "local",
    "desktop_mcp",
  ] as const)("a %s server is installed", (serverType) => {
    expect(usesInstallations(serverType)).toBe(true);
  });

  it.each([
    "remote",
    "builtin",
    undefined,
  ] as const)("a %s server is not", (serverType) => {
    expect(usesInstallations(serverType)).toBe(false);
  });
});

describe("runsInEnvironment", () => {
  it("names no environment for a built-in or a desktop MCP server", () => {
    expect(runsInEnvironment("builtin")).toBe(false);
    expect(runsInEnvironment("desktop_mcp")).toBe(false);
    expect(runsInEnvironment("local")).toBe(true);
    expect(runsInEnvironment("remote")).toBe(true);
  });
});
