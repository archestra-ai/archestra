import { ARCHESTRA_TOOL_PREFIX, DEFAULT_APP_NAME } from "@archestra/shared";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import { archestraMcpBranding } from "./branding";
import { getArchestraMcpTools } from "./index";

/**
 * Built-in tool descriptions are shipped strings frozen at module load, so they
 * are rebranded when `getArchestraMcpTools()` builds the list rather than
 * inline. These tests pin that the LLM-facing description text follows the
 * deployment's brand, not just the tool *name* (which was already branded).
 */
function setFullWhiteLabeling(enabled: boolean): boolean {
  const original = config.enterpriseFeatures.fullWhiteLabeling;
  (
    config.enterpriseFeatures as { fullWhiteLabeling: boolean }
  ).fullWhiteLabeling = enabled;
  return original;
}

function allDescriptions(): string {
  return getArchestraMcpTools()
    .map((tool) =>
      typeof tool.description === "string" ? tool.description : "",
    )
    .join("\n");
}

describe("built-in tool description branding", () => {
  afterEach(() => {
    archestraMcpBranding.syncFromOrganization(null);
  });

  test("keeps the default brand when full white-labeling is off", () => {
    // The backend test env force-enables full white-labeling, so turn it off
    // explicitly to assert the non-enterprise path.
    const original = setFullWhiteLabeling(false);
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    try {
      expect(allDescriptions()).toContain(DEFAULT_APP_NAME);
    } finally {
      setFullWhiteLabeling(original);
    }
  });

  test("rewrites the brand in descriptions under full white-labeling", () => {
    const original = setFullWhiteLabeling(true);
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    try {
      const descriptions = allDescriptions();

      // The vendor brand must not reach the model under someone else's brand.
      expect(descriptions).not.toContain(DEFAULT_APP_NAME);
      expect(descriptions).toContain("Acme Copilot");
      // Tool names referenced inside descriptions carry the branded prefix, so
      // a name the model reads is a name it can actually call.
      expect(descriptions).not.toContain(ARCHESTRA_TOOL_PREFIX);
    } finally {
      setFullWhiteLabeling(original);
    }
  });
});
