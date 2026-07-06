import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_TOOL_PREFIX, isAgentTool } from "./agents";
import {
  APP_ARCHESTRA_TOOL_SHORT_NAMES,
  DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
  getArchestraAppResourceUri,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
  getCreationDefaultArchestraToolShortNames,
  isAlwaysExposedArchestraToolShortName,
  isArchestraMcpServerTool,
  PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  parseArchestraAppResourceUri,
  SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
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

  test("flags the skill, sandbox, and persistent-files path as always-exposed", () => {
    for (const shortName of [
      "list_skills",
      "load_skill",
      "run_command",
      "download_file",
      "upload_file",
      // persistent-files (Projects) surface — all top-level, including
      // delete_file (deleting a file is part of the everyday file flow here,
      // unlike the app tools below).
      "search_files",
      "read_file",
      "save_file",
      "edit_file",
      "delete_file",
    ]) {
      expect(isAlwaysExposedArchestraToolShortName(shortName)).toBe(true);
    }
    // The whole app surface is reached through search_tools/run_tool in
    // search_and_run_only mode.
    for (const shortName of [
      "scaffold_app",
      "refine_app",
      "edit_app",
      "validate_app",
      "publish_app",
      "read_app",
      "render_app",
      "list_apps",
      "set_app_tools",
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

  describe("getCreationDefaultArchestraToolShortNames", () => {
    const allOff = {
      skillsEnabled: false,
      sandboxEnabled: false,
    };

    test("all flags off yields the always-on defaults plus the app tools", () => {
      expect(getCreationDefaultArchestraToolShortNames(allOff)).toEqual([
        ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
        ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
      ]);
    });

    test("skillsEnabled adds the skill tools", () => {
      expect(
        getCreationDefaultArchestraToolShortNames({
          ...allOff,
          skillsEnabled: true,
        }),
      ).toEqual([
        ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
        ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
        ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
      ]);
    });

    test("sandboxEnabled adds the runtime and persistent-files tools", () => {
      expect(
        getCreationDefaultArchestraToolShortNames({
          ...allOff,
          sandboxEnabled: true,
        }),
      ).toEqual([
        ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
        ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
        ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
        ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
      ]);
    });

    test("all flags on composes every group in order", () => {
      expect(
        getCreationDefaultArchestraToolShortNames({
          skillsEnabled: true,
          sandboxEnabled: true,
        }),
      ).toEqual([
        ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
        ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
        ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
        ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
        ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
      ]);
    });
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

describe("parseArchestraAppResourceUri", () => {
  test("round-trips an owned-app id", () => {
    const appId = "947051c7-ea8e-48ed-8077-a3cc904d9d61";
    expect(
      parseArchestraAppResourceUri(getArchestraAppResourceUri(appId)),
    ).toBe(appId);
  });

  test("returns null for a non-app UI URI", () => {
    expect(parseArchestraAppResourceUri("ui://excalidraw")).toBeNull();
  });

  test("returns null for the bare prefix (no app id)", () => {
    expect(parseArchestraAppResourceUri("ui://archestra-app/")).toBeNull();
  });

  test("returns null when the URI has a path past the app id", () => {
    expect(
      parseArchestraAppResourceUri("ui://archestra-app/abc/extra"),
    ).toBeNull();
  });
});
