import { describe, expect, test } from "vitest";
import {
  buildSlackSlashCommands,
  buildSlackSlashCommandsForCommand,
  getSlackSlashCommandAction,
  SLACK_SLASH_COMMANDS,
} from "./slack";

describe("Slack slash commands", () => {
  test("builds default Archestra commands", () => {
    expect(SLACK_SLASH_COMMANDS).toEqual({
      SELECT_AGENT: "/archestra-select-agent",
      STATUS: "/archestra-status",
      HELP: "/archestra-help",
    });
  });

  test("slugifies app names with hyphens", () => {
    expect(buildSlackSlashCommands("Archestra Staging")).toEqual({
      SELECT_AGENT: "/archestra-staging-select-agent",
      STATUS: "/archestra-staging-status",
      HELP: "/archestra-staging-help",
    });
  });

  test.each([
    ["a".repeat(18), "a".repeat(18)],
    ["a".repeat(19), "a".repeat(18)],
    ["Archestra Engineering", "archestra-engineer"],
    ["abcdefghijklmnopq remainder", "abcdefghijklmnopq"],
    ["!!!", "archestra"],
  ])("bounds commands for %s while preserving routing", (appName, prefix) => {
    const commands = buildSlackSlashCommands(appName);
    expect(commands.SELECT_AGENT).toBe(`/${prefix}-select-agent`);
    for (const [action, command] of Object.entries(commands)) {
      expect(command.length).toBeLessThanOrEqual(32);
      expect(getSlackSlashCommandAction(command)).toBe(action);
      expect(buildSlackSlashCommandsForCommand(command)).toEqual(commands);
    }
  });

  test("detects command actions from any app-name prefix", () => {
    expect(getSlackSlashCommandAction("/archestra-staging-select-agent")).toBe(
      "SELECT_AGENT",
    );
    expect(getSlackSlashCommandAction("/archestra-staging-status")).toBe(
      "STATUS",
    );
    expect(getSlackSlashCommandAction("/archestra-staging-help")).toBe("HELP");
    expect(getSlackSlashCommandAction("/archestra-staging-unknown")).toBeNull();
  });

  test("rebuilds sibling commands from a received command prefix", () => {
    expect(
      buildSlackSlashCommandsForCommand("/archestra-staging-help"),
    ).toEqual({
      SELECT_AGENT: "/archestra-staging-select-agent",
      STATUS: "/archestra-staging-status",
      HELP: "/archestra-staging-help",
    });
  });
});
