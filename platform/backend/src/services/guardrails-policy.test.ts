import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { parse } from "smol-toml";
import { afterEach, describe, expect, test } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { initialPolicy } from "./guardrails-policy";

describe("initialPolicy", () => {
  const fullWhiteLabeling = config.enterpriseFeatures.fullWhiteLabeling;
  afterEach(() => {
    config.enterpriseFeatures.fullWhiteLabeling = fullWhiteLabeling;
    archestraMcpBranding.syncFromOrganization(null);
  });

  test.each([
    ["the default branding", null],
    ["a white-labeled deployment", "Acme Hub"],
  ])("under %s, run_command goes to the archestra annotator, control tools carry no label, and other tools go to noop", (_, appName) => {
    config.enterpriseFeatures.fullWhiteLabeling = appName !== null;
    archestraMcpBranding.syncFromOrganization({ appName, iconLogo: null });

    const { policy } = parse(initialPolicy()) as unknown as {
      policy: {
        annotator: Array<{ name: string; builtin?: string }>;
        tool: Array<{
          name: string;
          annotator?: string;
          delta?: Record<string, unknown>;
        }>;
      };
    };
    // The runtime picks the first rule that matches a call.
    const rule = (tool: string) =>
      policy.tool.find((r) => r.name === tool || r.name === "*");
    const governing = (tool: string) =>
      policy.annotator.find((a) => a.name === rule(tool)?.annotator);

    expect(
      governing(archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME)),
    ).toEqual(expect.objectContaining({ builtin: "archestra" }));
    for (const shortName of [
      TOOL_SEARCH_TOOLS_SHORT_NAME,
      TOOL_ASK_USER_SHORT_NAME,
    ] as const) {
      expect(rule(archestraMcpBranding.getToolName(shortName))).toEqual({
        name: archestraMcpBranding.getToolName(shortName),
        delta: {},
      });
    }
    expect(
      governing(archestraMcpBranding.getToolName(TOOL_TODO_WRITE_SHORT_NAME)),
    ).toEqual({ name: "noop" });
  });
});
