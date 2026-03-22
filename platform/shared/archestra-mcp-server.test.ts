import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_TOOL_PREFIX, isAgentTool } from "./agents";
import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
  isArchestraMcpServerTool,
  TOOL_CREATE_AGENT_FULL_NAME,
} from "./archestra-mcp-server";

describe("archestra MCP tool names", () => {
  test("contains the shared special tool short names", () => {
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("create_agent");
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("swap_agent");
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("artifact_write");
  });

  test("builds a fully-qualified Archestra tool name", () => {
    expect(getArchestraToolFullName("create_agent")).toBe(
      TOOL_CREATE_AGENT_FULL_NAME,
    );
  });

  test("preserves literal full-name typing", () => {
    const fullName = getArchestraToolFullName("create_agent");
    expectTypeOf(fullName).toEqualTypeOf<typeof TOOL_CREATE_AGENT_FULL_NAME>();
  });

  test("slugifies branded tool prefixes for non-alphanumeric app names", () => {
    expect(
      getArchestraMcpServerName({
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra");
    expect(
      getArchestraToolPrefix({
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__");
    expect(
      getArchestraToolFullName("create_agent", {
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__create_agent");
  });

  test("falls back to the default built-in prefix when branding slugifies to empty", () => {
    expect(
      getArchestraMcpServerName({
        appName: "❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra");
    expect(
      getArchestraToolFullName("create_agent", {
        appName: "❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__create_agent");
  });

  test("extracts the short name from an Archestra tool", () => {
    expect(getArchestraToolShortName(TOOL_CREATE_AGENT_FULL_NAME)).toBe(
      "create_agent",
    );
  });

  test("returns null for unknown or non-Archestra tool names", () => {
    expect(getArchestraToolShortName("archestra__poop")).toBeNull();
    expect(getArchestraToolShortName("github__list_issues")).toBeNull();
  });

  test("identifies Archestra and agent tools by prefix", () => {
    expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
    expect(isArchestraMcpServerTool("github__list_issues")).toBe(false);
    expect(isAgentTool(`${AGENT_TOOL_PREFIX}delegate_me`)).toBe(true);
    expect(isAgentTool("archestra__whoami")).toBe(false);
  });
});
