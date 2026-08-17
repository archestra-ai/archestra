import { describe, expect, it } from "vitest";
import {
  integrationDescription,
  integrationLabel,
  isIntegrationHidden,
  KnowledgeConnectorIdSchema,
  MessagingChannelIdSchema,
  pruneIntegrationOverrides,
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

describe("integrationDescription", () => {
  it("returns null when unset or blank", () => {
    expect(integrationDescription(null, "slack")).toBeNull();
    expect(
      integrationDescription({ slack: { description: " " } }, "slack"),
    ).toBeNull();
  });

  it("returns the admin's blurb when set", () => {
    expect(
      integrationDescription(
        { slack: { description: "Corp workspace" } },
        "slack",
      ),
    ).toBe("Corp workspace");
  });
});

describe("pruneIntegrationOverrides", () => {
  it("drops entries that carry no customization", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { hidden: false, displayName: "", description: "" },
        gemini: { hidden: false, displayName: "   ", description: "" },
      }),
    ).toBeNull();
  });

  it("keeps only the fields the admin actually set", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { hidden: true, displayName: "", description: "" },
        gemini: { hidden: false, displayName: " Gemini Pro ", description: "" },
      }),
    ).toEqual({
      openai: { hidden: true },
      gemini: { displayName: "Gemini Pro" },
    });
  });

  it("keeps a label on a turned-off entry so re-enabling restores the name", () => {
    expect(
      pruneIntegrationOverrides({
        slack: { hidden: true, displayName: "Slack (corp)", description: "" },
      }),
    ).toEqual({ slack: { hidden: true, displayName: "Slack (corp)" } });
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
