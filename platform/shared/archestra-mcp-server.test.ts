import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_TOOL_PREFIX, isAgentTool } from "./agents";
import {
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
  isAlwaysExposedArchestraToolShortName,
  isArchestraMcpServerTool,
  TOOL_CREATE_AGENT_FULL_NAME,
} from "./archestra-mcp-server";

describe("archestra MCP tool names", () => {
  test("builds a fully-qualified Archestra tool name with literal typing", () => {
    const fullName = getArchestraToolFullName("create_agent");
    expect(fullName).toBe(TOOL_CREATE_AGENT_FULL_NAME);
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

  test("flags the skill, sandbox, persistent-files, and app runtime path as always-exposed", () => {
    for (const shortName of [
      "list_skills",
      "load_skill",
      "run_command",
      "download_file",
      "upload_file",
      // persistent-files (Projects) surface — all top-level, including
      // delete_file (deleting a file is part of the everyday file flow here,
      // unlike delete_app below).
      "search_files",
      "read_file",
      "save_file",
      "edit_file",
      "delete_file",
      "scaffold_app",
      "edit_app",
      "read_app",
      "render_app",
      "list_apps",
    ]) {
      expect(isAlwaysExposedArchestraToolShortName(shortName)).toBe(true);
    }
    // delete_app stays search-gated (destructive); preview_app_tool and
    // get_app_diagnostics are follow-up steps reached via run_tool.
    for (const shortName of [
      "delete_app",
      "preview_app_tool",
      "get_app_diagnostics",
    ]) {
      expect(isAlwaysExposedArchestraToolShortName(shortName)).toBe(false);
    }
  });

  test("recognizes always-exposed tools through a white-label prefix", () => {
    const branding = { appName: "Acme Control Plane", fullWhiteLabeling: true };
    const brandedLoad = getArchestraToolFullName("load_skill", branding);
    const shortName = getArchestraToolShortName(brandedLoad, branding);

    expect(shortName).toBe("load_skill");
    expect(
      shortName !== null && isAlwaysExposedArchestraToolShortName(shortName),
    ).toBe(true);
  });

  test("does not flag skill-authoring or unrelated tools", () => {
    for (const shortName of [
      "create_skill",
      "update_skill",
      "whoami",
      "search_tools",
      "run_tool",
    ]) {
      expect(isAlwaysExposedArchestraToolShortName(shortName)).toBe(false);
    }
  });
});
