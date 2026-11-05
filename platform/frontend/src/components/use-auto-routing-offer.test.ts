import { describe, expect, it } from "vitest";
import { autoRoutingOffer } from "./use-auto-routing-offer";

const tiers = {
  fast: { id: "1", provider: "openai", modelId: "gpt-5.5-mini" },
  normal: { id: "2", provider: "openai", modelId: "gpt-5.5" },
  smart: { id: "3", provider: "anthropic", modelId: "claude-opus-5-5" },
} as const;
const chat = ["/chat/completions"];
const routableModels = [
  { value: "openai:gpt-5.5-mini", supportedEndpoints: chat },
  { value: "openai:gpt-5.5", supportedEndpoints: chat },
  { value: "anthropic:claude-opus-5-5", supportedEndpoints: chat },
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

  it("is available on chat completions when the credential reaches every tier model", () => {
    expect(autoRoutingOffer({ ...base, canConfigure: false })).toEqual({
      kind: "available",
      endpoint: "chat/completions",
    });
  });

  it("uses Responses when a tier model is published only on Responses", () => {
    expect(
      autoRoutingOffer({
        ...base,
        routableModels: [
          ...routableModels.slice(0, 2),
          {
            value: "anthropic:claude-opus-5-5",
            supportedEndpoints: ["/responses"],
          },
        ],
      }),
    ).toEqual({ kind: "available", endpoint: "responses" });
  });

  it("refuses when a Responses-only tier meets a Chat Completions-only provider", () => {
    const kimiTiers = {
      ...tiers,
      fast: { id: "4", provider: "kimi", modelId: "kimi-k2" },
      smart: { id: "5", provider: "openai", modelId: "gpt-5.4-codex" },
    } as const;
    expect(
      autoRoutingOffer({
        ...base,
        settings: { enabled: true, tiers: kimiTiers },
        routableModels: [
          { value: "kimi:kimi-k2", supportedEndpoints: chat },
          { value: "openai:gpt-5.5", supportedEndpoints: chat },
          { value: "openai:gpt-5.4-codex", supportedEndpoints: null },
        ],
      }),
    ).toEqual({ kind: "no-shared-endpoint" });
  });

  it("lists the tiers whose models the credential can't reach", () => {
    expect(
      autoRoutingOffer({ ...base, routableModels: routableModels.slice(0, 1) }),
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
