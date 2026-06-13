import { ARCHESTRA_TOOL_PREFIX, DEFAULT_APP_NAME } from "@archestra/shared";
import { afterEach, describe, expect, test } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { applyBuiltInSkillBranding } from "./built-in-skill-branding";

/**
 * The swap reads the synced `archestraMcpBranding` singleton and
 * `config.enterpriseFeatures`, so the tests toggle full white-labeling and sync
 * an org exactly as the seed path does, then restore both.
 */
function setFullWhiteLabeling(enabled: boolean): boolean {
  const original = config.enterpriseFeatures.fullWhiteLabeling;
  (
    config.enterpriseFeatures as { fullWhiteLabeling: boolean }
  ).fullWhiteLabeling = enabled;
  return original;
}

const SAMPLE = `# Archestra Platform Operations

Operate the Archestra platform with its built-in tools (prefixed
\`archestra__\`, e.g. \`archestra__create_agent\`). Archestra blocks leaks.`;

describe("applyBuiltInSkillBranding", () => {
  afterEach(() => {
    archestraMcpBranding.syncFromOrganization(null);
  });

  test("is a no-op without full white-labeling", () => {
    // even with an app name set, the brand stays "Archestra" until the
    // enterprise flag is on — mirroring getArchestraMcpCatalogName. The backend
    // test env force-enables full white-labeling, so disable it explicitly here.
    const original = setFullWhiteLabeling(false);
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    try {
      expect(applyBuiltInSkillBranding(SAMPLE)).toBe(SAMPLE);
    } finally {
      setFullWhiteLabeling(original);
    }
  });

  test("is a no-op when full white-labeling is on but no app name is set", () => {
    const original = setFullWhiteLabeling(true);
    archestraMcpBranding.syncFromOrganization({
      appName: null,
      iconLogo: null,
    });
    try {
      expect(applyBuiltInSkillBranding(SAMPLE)).toBe(SAMPLE);
    } finally {
      setFullWhiteLabeling(original);
    }
  });

  test("rewrites the brand and tool prefix under full white-labeling", () => {
    const original = setFullWhiteLabeling(true);
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    try {
      const branded = applyBuiltInSkillBranding(SAMPLE);

      expect(branded).not.toContain(DEFAULT_APP_NAME);
      expect(branded).not.toContain(ARCHESTRA_TOOL_PREFIX);
      expect(branded).toContain(archestraMcpBranding.catalogName);
      expect(branded).toContain("Acme Copilot Platform Operations");
      // a full tool name carries the branded prefix, so the model calls the
      // name that actually exists for this org.
      expect(branded).toContain(
        `${archestraMcpBranding.toolPrefix}create_agent`,
      );
    } finally {
      setFullWhiteLabeling(original);
    }
  });
});
