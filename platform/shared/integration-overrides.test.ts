import { describe, expect, it } from "vitest";
import {
  allowedIntegrationIds,
  integrationLabel,
  isIntegrationHidden,
  KnowledgeConnectorIdSchema,
  MessagingChannelIdSchema,
  pruneIntegrationOverrides,
  withAllowedIntegrationIds,
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
