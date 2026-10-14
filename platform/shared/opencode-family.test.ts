import { describe, expect, test } from "vitest";
import {
  INSTALLER_CLIENT_FOOTPRINT,
  INSTALLER_CLIENT_LABELS,
  OAUTH_AGENTS,
} from "./connection-setup";
import { STARTUP_GUARD_INSTALL } from "./consts";
import {
  CLIENT_FILTER_OPTIONS,
  clientFilterToAgentIds,
  isKiloUserAgent,
  isOpenCodeUserAgent,
} from "./interactions/client";
import {
  isOpenCodeFamilyClient,
  isOpenCodeFamilySessionSource,
  OPENCODE_FAMILY,
  OPENCODE_FAMILY_CLIENT_IDS,
  openCodeFamilyClientForUserAgent,
  openCodeFamilyRecord,
} from "./opencode-family";

describe("OpenCode family", () => {
  test("Kilo Code differs from OpenCode only in its names, files, session source and identity", () => {
    expect(OPENCODE_FAMILY_CLIENT_IDS).toEqual(["opencode", "kilo"]);
    const { opencode, kilo } = OPENCODE_FAMILY;
    const differing = (Object.keys(opencode) as (keyof typeof opencode)[])
      .filter(
        (key) => JSON.stringify(opencode[key]) !== JSON.stringify(kilo[key]),
      )
      .sort();
    expect(differing).toEqual([
      "binary",
      "commentedConfigFile",
      "configFile",
      "dir",
      "guardEnvVar",
      "icon",
      "id",
      "label",
      "manualConfigFile",
      "oauth",
      "sessionSource",
      "stateName",
      "userAgentTokens",
    ]);
    // Kilo's own `mcp add` writes the commented file; OpenCode's does not.
    expect(kilo.mcpAddConfigFile).toBe("kilo.jsonc");
    expect(opencode.mcpAddConfigFile).toBeUndefined();
  });

  test("the per-client records derive from the descriptor", () => {
    expect(openCodeFamilyRecord((client) => client.binary)).toEqual({
      opencode: "opencode",
      kilo: "kilo",
    });
    expect(INSTALLER_CLIENT_LABELS.kilo).toBe("Kilo Code");
    expect(INSTALLER_CLIENT_FOOTPRINT.kilo[0]).toBe(
      "kilo.json (gateway and model routing)",
    );
    expect(INSTALLER_CLIENT_FOOTPRINT.opencode[1]).toBe(
      "Skills folder in ~/.config/opencode/skills/",
    );
    expect(STARTUP_GUARD_INSTALL.kilo).toEqual({
      scriptRelpath: ".archestra/kilo-startup-guard.sh",
      psScriptRelpath: ".archestra/kilo-startup-guard.ps1",
      skipRelpath: ".archestra/kilo-startup-guard.skip",
      markerStart: "# >>> archestra kilo guard >>>",
      markerEnd: "# <<< archestra kilo guard <<<",
    });
    expect(OAUTH_AGENTS.kilo).toEqual({
      label: "Kilo Code",
      identities: [
        { clientId: "https://kilo.ai/docs/oauth/kilo/client.json" },
        { clientNamePattern: "^Kilo$" },
      ],
    });
    expect(OAUTH_AGENTS.opencode?.identities[1]).toEqual({
      clientNamePattern: "^OpenCode$",
    });
  });

  test("identifies each member by id, User-Agent and session source", () => {
    expect(isOpenCodeFamilyClient("kilo")).toBe(true);
    expect(isOpenCodeFamilyClient("codex")).toBe(false);
    expect(
      openCodeFamilyClientForUserAgent("kilo/latest/7.8.8/cli ai-sdk/4.0.46")
        ?.id,
    ).toBe("kilo");
    expect(
      openCodeFamilyClientForUserAgent("opencode/1.18.32 ai-sdk/4.0.46")?.id,
    ).toBe("opencode");
    expect(openCodeFamilyClientForUserAgent("Anthropic/JS 0.78.0")).toBeNull();
    expect(isKiloUserAgent("kilo/latest/7.8.8/cli")).toBe(true);
    // Kilo's provider requests carry its product name.
    expect(
      isKiloUserAgent("Kilo-Code/7.8.8 ai-sdk/provider-utils/4.0.46"),
    ).toBe(true);
    expect(
      openCodeFamilyClientForUserAgent("Kilo-Code/7.8.8 ai-sdk/4.0.46")?.id,
    ).toBe("kilo");
    expect(isOpenCodeUserAgent("kilo/latest/7.8.8/cli")).toBe(false);
    expect(isOpenCodeUserAgent("opencode/1.18.32")).toBe(true);
    expect(isOpenCodeFamilySessionSource("kilo_session")).toBe(true);
    expect(isOpenCodeFamilySessionSource("opencode_session")).toBe(true);
    expect(isOpenCodeFamilySessionSource("codex_session")).toBe(false);
    expect(clientFilterToAgentIds("kilo")).toEqual(["kilo"]);
    expect(
      CLIENT_FILTER_OPTIONS.find((option) => option.value === "kilo"),
    ).toEqual({
      value: "kilo",
      label: "Kilo Code",
      provider: "openai",
      icon: "/icons/kilo.png",
    });
  });
});
