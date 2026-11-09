import { describe, expect, it } from "vitest";
import { autoRoutingOffer } from "./use-auto-routing-offer";

const apiKey = { id: "key-1", name: "Organization key" };
const tiers = {
  fast: { id: "1", provider: "openai", modelId: "gpt-5.5-mini", apiKey },
  normal: { id: "2", provider: "openai", modelId: "gpt-5.5", apiKey },
  smart: { id: "3", provider: "anthropic", modelId: "claude-opus-5-5", apiKey },
} as const;
const chat = ["/chat/completions"];
const routableModels = [
  { value: "openai:gpt-5.5-mini", supportedEndpoints: chat },
  { value: "openai:gpt-5.5", supportedEndpoints: chat },
  { value: "anthropic:claude-opus-5-5", supportedEndpoints: chat },
];
type OfferedRouter = NonNullable<
  Parameters<typeof autoRoutingOffer>[0]["routers"]
>[number];
const router = (
  name: string,
  overrides: Partial<{
    enabled: boolean;
    tiers: Record<"fast" | "normal" | "smart", unknown>;
    virtualApiKeyIds: string[];
  }> = {},
) =>
  ({
    name,
    enabled: true,
    tiers,
    virtualApiKeyIds: [],
    ...overrides,
  }) as OfferedRouter;
const base = {
  featureEnabled: true,
  routers: [router("auto")],
  virtualApiKeyId: null,
  canConfigure: true,
  routableModels,
  modelsPending: false,
};

describe("autoRoutingOffer", () => {
  it("offers nothing while the alpha is off or the routers are unavailable", () => {
    expect(autoRoutingOffer({ ...base, featureEnabled: false })).toEqual({
      kind: "none",
    });
    expect(autoRoutingOffer({ ...base, routers: null })).toEqual({
      kind: "none",
    });
  });

  it("offers setup when auto routing is off or a tier has no model", () => {
    expect(
      autoRoutingOffer({
        ...base,
        routers: [router("auto", { enabled: false })],
      }),
    ).toEqual({ kind: "setup" });
    expect(
      autoRoutingOffer({
        ...base,
        routers: [router("auto", { tiers: { ...tiers, smart: null } })],
      }),
    ).toEqual({ kind: "setup" });
  });

  it("offers nothing instead of setup to viewers who can't configure it", () => {
    expect(
      autoRoutingOffer({
        ...base,
        canConfigure: false,
        routers: [router("auto", { enabled: false })],
      }),
    ).toEqual({ kind: "none" });
  });

  it("is available on chat completions when the credential reaches every tier model", () => {
    expect(autoRoutingOffer({ ...base, canConfigure: false })).toEqual({
      kind: "available",
      routers: [{ name: "auto", endpoint: "chat/completions" }],
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
    ).toEqual({
      kind: "available",
      routers: [{ name: "auto", endpoint: "responses" }],
    });
  });

  it("refuses when a Responses-only tier meets a Chat Completions-only provider", () => {
    const kimiTiers = {
      ...tiers,
      fast: { id: "4", provider: "kimi", modelId: "kimi-k2", apiKey },
      smart: { id: "5", provider: "openai", modelId: "gpt-5.4-codex", apiKey },
    } as const;
    expect(
      autoRoutingOffer({
        ...base,
        routers: [router("auto", { tiers: kimiTiers })],
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

  describe("virtual keys", () => {
    const secondTiers = {
      fast: { id: "6", provider: "openai", modelId: "gpt-5.5-nano", apiKey },
      normal: { id: "7", provider: "openai", modelId: "gpt-5.5", apiKey },
      smart: { id: "8", provider: "openai", modelId: "gpt-5.5-max", apiKey },
    } as const;
    const routers = [
      router("auto", { virtualApiKeyIds: ["key-a"] }),
      router("auto:support", {
        tiers: secondTiers,
        virtualApiKeyIds: ["key-b"],
      }),
    ];

    it("offers a virtual key only the router it was given", () => {
      expect(
        autoRoutingOffer({ ...base, routers, virtualApiKeyId: "key-b" }),
      ).toEqual({
        kind: "available",
        routers: [{ name: "auto:support", endpoint: "chat/completions" }],
      });
    });

    it("offers every router a virtual key was given, regardless of its own models", () => {
      expect(
        autoRoutingOffer({
          ...base,
          routers: routers.map((r) => ({ ...r, virtualApiKeyIds: ["key-a"] })),
          virtualApiKeyId: "key-a",
          routableModels: [],
        }),
      ).toEqual({
        kind: "available",
        routers: [
          { name: "auto", endpoint: "chat/completions" },
          { name: "auto:support", endpoint: "chat/completions" },
        ],
      });
    });

    it("tells a virtual key with none of the routers that it is unassigned", () => {
      expect(
        autoRoutingOffer({ ...base, routers, virtualApiKeyId: "key-c" }),
      ).toEqual({ kind: "unassigned" });
    });

    it("keeps the reachability rule for a credential that is not a virtual key", () => {
      expect(
        autoRoutingOffer({
          ...base,
          routers,
          routableModels: routableModels.slice(0, 1),
        }),
      ).toEqual({
        kind: "unreachable",
        missing: [
          { tier: "normal", provider: "openai" },
          { tier: "smart", provider: "anthropic" },
        ],
      });
    });
  });
});
