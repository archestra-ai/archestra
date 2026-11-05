import { describe, expect, it } from "vitest";
import { autoRoutingOffer } from "./use-auto-routing-offer";

const tiers = {
  fast: { id: "1", provider: "openai", modelId: "gpt-5.5-mini" },
  normal: { id: "2", provider: "openai", modelId: "gpt-5.5" },
  smart: { id: "3", provider: "anthropic", modelId: "claude-opus-5-5" },
} as const;
const routableModels = [
  "openai:gpt-5.5-mini",
  "openai:gpt-5.5",
  "anthropic:claude-opus-5-5",
];
const base = {
  featureEnabled: true,
  settings: { enabled: true, tiers },
  canConfigure: true,
  routableModels,
  modelsPending: false,
};

describe("autoRoutingOffer", () => {
  it("offers nothing while the alpha is off or the settings are unavailable", () => {
    expect(autoRoutingOffer({ ...base, featureEnabled: false })).toEqual({
      kind: "none",
    });
    expect(autoRoutingOffer({ ...base, settings: null })).toEqual({
      kind: "none",
    });
  });

  it("offers setup when auto routing is off or a tier has no model", () => {
    expect(
      autoRoutingOffer({ ...base, settings: { enabled: false, tiers } }),
    ).toEqual({ kind: "setup" });
    expect(
      autoRoutingOffer({
        ...base,
        settings: { enabled: true, tiers: { ...tiers, smart: null } },
      }),
    ).toEqual({ kind: "setup" });
  });

  it("offers nothing instead of setup to viewers who can't configure it", () => {
    expect(
      autoRoutingOffer({
        ...base,
        canConfigure: false,
        settings: { enabled: false, tiers },
      }),
    ).toEqual({ kind: "none" });
  });

  it("is available when the credential reaches every tier model", () => {
    expect(autoRoutingOffer({ ...base, canConfigure: false })).toEqual({
      kind: "available",
    });
  });

  it("lists the tiers whose models the credential can't reach", () => {
    expect(
      autoRoutingOffer({ ...base, routableModels: ["openai:gpt-5.5-mini"] }),
    ).toEqual({
      kind: "unreachable",
      missing: [
        { tier: "normal", provider: "openai" },
        { tier: "smart", provider: "anthropic" },
      ],
    });
  });

  it("waits for the credential's models before judging reachability", () => {
    expect(
      autoRoutingOffer({ ...base, routableModels: [], modelsPending: true }),
    ).toEqual({ kind: "none" });
  });
});
