import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allowedIntegrationIds,
  copilotEnterprisePlanLabel,
  integrationLabel,
  isCopilotPlanHidden,
  isIntegrationHidden,
  KnowledgeConnectorIdSchema,
  MessagingChannelIdSchema,
  ModelProviderOverridesSchema,
  orderedPopularAgentIds,
  PopularAgentIdSchema,
  PopularAgentOverridesSchema,
  pruneIntegrationOverrides,
  StoredModelProviderOverridesSchema,
  withAllowedIntegrationIds,
  withOrderedPopularAgentIds,
} from "./integration-overrides";
import { CONNECTOR_TYPE_LABELS } from "./knowledge-base";

describe("isIntegrationHidden", () => {
  it("treats a missing entry as visible so new catalog entries ship on", () => {
    expect(isIntegrationHidden(null, "openai")).toBe(false);
    expect(isIntegrationHidden({}, "openai")).toBe(false);
    expect(isIntegrationHidden({ openai: {} }, "openai")).toBe(false);
  });

  it("hides only entries explicitly switched off", () => {
    const overrides = { openai: { hidden: true }, gemini: { hidden: false } };
    expect(isIntegrationHidden(overrides, "openai")).toBe(true);
    expect(isIntegrationHidden(overrides, "gemini")).toBe(false);
  });
});

describe("integrationLabel", () => {
  it("falls back to the built-in name when no override is set", () => {
    expect(integrationLabel(null, "openai", "OpenAI")).toBe("OpenAI");
    expect(integrationLabel({ openai: {} }, "openai", "OpenAI")).toBe("OpenAI");
  });

  it("ignores a whitespace-only override rather than rendering a blank name", () => {
    expect(
      integrationLabel({ openai: { displayName: "   " } }, "openai", "OpenAI"),
    ).toBe("OpenAI");
  });

  it("uses the admin's label when set", () => {
    expect(
      integrationLabel(
        { openai: { displayName: "OpenAI (approved)" } },
        "openai",
        "OpenAI",
      ),
    ).toBe("OpenAI (approved)");
  });
});

describe("pruneIntegrationOverrides", () => {
  it("drops entries that carry no customization", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { hidden: false, displayName: "" },
        gemini: { hidden: false, displayName: "   " },
      }),
    ).toBeNull();
  });

  it("keeps only the fields the admin actually set", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { hidden: true, displayName: "" },
        gemini: { hidden: false, displayName: " Gemini Pro " },
      }),
    ).toEqual({
      openai: { hidden: true },
      gemini: { displayName: "Gemini Pro" },
    });
  });

  it("keeps a label on a turned-off provider so re-enabling restores the name", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { hidden: true, displayName: "OpenAI (retired)" },
      }),
    ).toEqual({ openai: { hidden: true, displayName: "OpenAI (retired)" } });
  });
});

describe("catalog id schemas", () => {
  it("covers every connector type the label map declares", () => {
    expect(new Set(KnowledgeConnectorIdSchema.options)).toEqual(
      new Set(Object.keys(CONNECTOR_TYPE_LABELS)),
    );
  });

  it("accepts the messaging channels the UI renders as tabs", () => {
    for (const channel of ["slack", "ms-teams", "telegram", "email", "a2a"]) {
      expect(MessagingChannelIdSchema.safeParse(channel).success).toBe(true);
    }
    expect(MessagingChannelIdSchema.safeParse("discord").success).toBe(false);
  });
});

const CATALOG = ["openai", "anthropic", "gemini"] as const;

describe("allowedIntegrationIds", () => {
  it("offers the whole catalog when nothing is switched off", () => {
    expect(allowedIntegrationIds(null, CATALOG)).toEqual([
      "openai",
      "anthropic",
      "gemini",
    ]);
  });

  it("drops the entries an admin hid, keeping catalog order", () => {
    expect(
      allowedIntegrationIds({ anthropic: { hidden: true } }, CATALOG),
    ).toEqual(["openai", "gemini"]);
  });

  it("counts a renamed-but-visible entry as offered", () => {
    expect(
      allowedIntegrationIds({ openai: { displayName: "Approved" } }, CATALOG),
    ).toEqual(["openai", "anthropic", "gemini"]);
  });
});

describe("withAllowedIntegrationIds", () => {
  it("stores nothing when every entry stays on", () => {
    expect(withAllowedIntegrationIds(null, CATALOG, CATALOG)).toBeNull();
  });

  it("hides exactly the entries left out of the allowed list", () => {
    expect(withAllowedIntegrationIds(null, CATALOG, ["openai"])).toEqual({
      anthropic: { hidden: true },
      gemini: { hidden: true },
    });
  });

  it("keeps the organization's name for an entry it switches off", () => {
    expect(
      withAllowedIntegrationIds(
        { openai: { displayName: "OpenAI (approved)" } },
        CATALOG,
        ["anthropic", "gemini"],
      ),
    ).toEqual({ openai: { hidden: true, displayName: "OpenAI (approved)" } });
  });

  it("restores an entry without losing the name it was given", () => {
    expect(
      withAllowedIntegrationIds(
        { openai: { hidden: true, displayName: "OpenAI (approved)" } },
        CATALOG,
        CATALOG,
      ),
    ).toEqual({ openai: { displayName: "OpenAI (approved)" } });
  });

  it("hides the whole catalog when the last chip is removed", () => {
    expect(withAllowedIntegrationIds(null, CATALOG, [])).toEqual({
      openai: { hidden: true },
      anthropic: { hidden: true },
      gemini: { hidden: true },
    });
  });
});

describe("popular agent request contract", () => {
  it("exposes the accepted optional template IDs to JSON Schema consumers", () => {
    const schema = z.toJSONSchema(PopularAgentOverridesSchema);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(
      PopularAgentIdSchema.options,
    );
    expect(schema.required ?? []).toEqual([]);
  });
});

describe("coding agent ordering", () => {
  const catalog = PopularAgentIdSchema.options;
  it("keeps default order, appends unpositioned entries, and excludes hidden entries", () => {
    expect(orderedPopularAgentIds(null, catalog)).toEqual(catalog);
    expect(
      orderedPopularAgentIds(
        {
          codex: { position: 0 },
          hermes: { hidden: true, position: 1 },
          opencode: { position: 0 },
        },
        catalog,
      ),
    ).toEqual([
      "codex",
      "opencode",
      "claude-code",
      "openclaw",
      "grok",
      "kimi",
      "copilot",
    ]);
  });
  it("round-trips reordering and restores a hidden entry at its new position", () => {
    const order = ["hermes", "codex", "claude-code"] as const;
    const overrides = withOrderedPopularAgentIds(
      { hermes: { hidden: true } },
      catalog,
      order,
    );
    expect(orderedPopularAgentIds(overrides, catalog)).toEqual(order);
    expect(overrides.hermes).toEqual({ position: 0 });
    expect(overrides.opencode).toEqual({ hidden: true });
  });
});

describe("GitHub Copilot plans", () => {
  it("offers both plans when nothing is turned off", () => {
    expect(isCopilotPlanHidden(null, "personal")).toBe(false);
    expect(isCopilotPlanHidden({ "github-copilot": {} }, "enterprise")).toBe(
      false,
    );
  });

  it("hides only the plan an admin turned off", () => {
    const overrides = {
      "github-copilot": { plans: { personal: { hidden: true } } },
    };
    expect(isCopilotPlanHidden(overrides, "personal")).toBe(true);
    expect(isCopilotPlanHidden(overrides, "enterprise")).toBe(false);
  });

  it("hides both plans when GitHub Copilot itself is off", () => {
    const overrides = { "github-copilot": { hidden: true } };
    expect(isCopilotPlanHidden(overrides, "personal")).toBe(true);
    expect(isCopilotPlanHidden(overrides, "enterprise")).toBe(true);
  });

  it("accepts one plan turned off on GitHub Copilot", () => {
    expect(
      ModelProviderOverridesSchema.safeParse({
        "github-copilot": { plans: { enterprise: { hidden: true } } },
      }).success,
    ).toBe(true);
  });

  it("refuses plans on any other provider", () => {
    expect(
      ModelProviderOverridesSchema.safeParse({
        openai: { plans: { personal: { hidden: true } } },
      }).success,
    ).toBe(false);
  });

  it("refuses both plans off, which is GitHub Copilot off", () => {
    expect(
      ModelProviderOverridesSchema.safeParse({
        "github-copilot": {
          plans: { personal: { hidden: true }, enterprise: { hidden: true } },
        },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown plan", () => {
    expect(
      ModelProviderOverridesSchema.safeParse({
        "github-copilot": { plans: { team: { hidden: true } } },
      }).success,
    ).toBe(false);
  });

  it("reads a stored row from a newer build without failing", () => {
    // An older build reads with this lenient schema: unknown keys drop, the
    // rest of the row stays usable.
    const parsed = StoredModelProviderOverridesSchema.parse({
      "github-copilot": {
        hidden: false,
        plans: { personal: { hidden: true }, future: { hidden: true } },
        futureField: 1,
      },
    });
    expect(parsed["github-copilot"]).toEqual({
      hidden: false,
      plans: { personal: { hidden: true } },
    });
  });

  it("keeps a turned-off plan through pruning, also while the provider is off", () => {
    expect(
      pruneIntegrationOverrides({
        "github-copilot": {
          hidden: true,
          plans: { personal: { hidden: true }, enterprise: { hidden: false } },
        },
      }),
    ).toEqual({
      "github-copilot": { hidden: true, plans: { personal: { hidden: true } } },
    });
  });

  it("names the enterprise plan GitHub Copilot Organization until an admin names it", () => {
    expect(copilotEnterprisePlanLabel(null)).toBe(
      "GitHub Copilot Organization",
    );
    expect(
      copilotEnterprisePlanLabel({
        "github-copilot": {
          displayName: "Copilot",
          plans: { enterprise: { displayName: " Copilot for Teams " } },
        },
      }),
    ).toBe("Copilot for Teams");
  });

  it("keeps the enterprise plan's name through pruning, and refuses a name on the personal plan", () => {
    expect(
      pruneIntegrationOverrides({
        "github-copilot": {
          plans: { enterprise: { hidden: false, displayName: " Org " } },
        },
      }),
    ).toEqual({
      "github-copilot": { plans: { enterprise: { displayName: "Org" } } },
    });
    expect(
      ModelProviderOverridesSchema.safeParse({
        "github-copilot": { plans: { personal: { displayName: "Mine" } } },
      }).success,
    ).toBe(false);
  });

  it("drops plans that are all on", () => {
    expect(
      pruneIntegrationOverrides({
        "github-copilot": {
          plans: { personal: { hidden: false }, enterprise: {} },
        },
      }),
    ).toBeNull();
  });

  it("keeps the plans when the availability chips rewrite the overrides", () => {
    expect(
      withAllowedIntegrationIds(
        { "github-copilot": { plans: { enterprise: { hidden: true } } } },
        ["openai", "github-copilot"],
        ["openai", "github-copilot"],
      ),
    ).toEqual({
      "github-copilot": { plans: { enterprise: { hidden: true } } },
    });
  });
});
