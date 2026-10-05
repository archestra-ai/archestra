import {
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
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
  ])("under %s, run_command goes to the archestra annotator and other tools to noop", (_, appName) => {
    config.enterpriseFeatures.fullWhiteLabeling = appName !== null;
    archestraMcpBranding.syncFromOrganization({ appName, iconLogo: null });

    const { policy } = parse(initialPolicy()) as unknown as {
      policy: {
        annotator: Array<{ name: string; builtin?: string }>;
        tool: Array<{ name: string; annotator?: string }>;
      };
    };
    // The runtime picks the first rule that matches a call.
    const governing = (tool: string) => {
      const rule = policy.tool.find((r) => r.name === tool || r.name === "*");
      return policy.annotator.find((a) => a.name === rule?.annotator);
    };

    expect(
      governing(archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME)),
    ).toEqual(expect.objectContaining({ builtin: "archestra" }));
    expect(
      governing(archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME)),
    ).toEqual({ name: "noop" });
  });
});
