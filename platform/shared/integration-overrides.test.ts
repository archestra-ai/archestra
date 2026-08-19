import { describe, expect, it } from "vitest";
import {
  integrationLabel,
  KnowledgeConnectorIdSchema,
  MessagingChannelIdSchema,
  pruneIntegrationOverrides,
} from "./integration-overrides";
import { CONNECTOR_TYPE_LABELS } from "./knowledge-base";

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
  it("drops entries that carry no name", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { displayName: "" },
        gemini: { displayName: "   " },
        anthropic: {},
      }),
    ).toBeNull();
  });

  it("keeps the trimmed names the admin actually set", () => {
    expect(
      pruneIntegrationOverrides({
        openai: { displayName: "" },
        gemini: { displayName: " Gemini Pro " },
      }),
    ).toEqual({ gemini: { displayName: "Gemini Pro" } });
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
