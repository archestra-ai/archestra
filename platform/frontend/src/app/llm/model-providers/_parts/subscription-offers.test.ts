import { describe, expect, it } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  buildSubscriptionOffers,
  subscriptionKindOfCredential,
} from "./subscription-offers";

function credential(
  overrides: Partial<LlmProviderApiKeyResponse> &
    Pick<LlmProviderApiKeyResponse, "provider">,
): LlmProviderApiKeyResponse {
  return {
    id: "key-1",
    name: "A key",
    scope: "personal",
    ...overrides,
  } as LlmProviderApiKeyResponse;
}

describe("subscriptionKindOfCredential", () => {
  it("identifies a provider-level subscription by its provider alone", () => {
    expect(
      subscriptionKindOfCredential(credential({ provider: "github-copilot" })),
    ).toBe("github-copilot");
  });

  it("identifies a credential-level subscription by the resolved secret kind", () => {
    expect(
      subscriptionKindOfCredential(
        credential({ provider: "openai", subscriptionKind: "chatgpt" }),
      ),
    ).toBe("chatgpt");
    expect(
      subscriptionKindOfCredential(credential({ provider: "openai" })),
    ).toBeNull();
  });

  it("never classifies from the mutable display name", () => {
    // An ordinary xAI key is allowed to be named after the subscription.
    expect(
      subscriptionKindOfCredential(
        credential({ provider: "xai", name: "X Premium (SuperGrok)" }),
      ),
    ).toBeNull();
  });

  it("treats a shared key as an ordinary credential", () => {
    // Subscriptions are per-user; a team- or org-scoped Copilot key is a
    // shared credential and must not take over the viewer's connect card.
    expect(
      subscriptionKindOfCredential(
        credential({ provider: "github-copilot", scope: "org" }),
      ),
    ).toBeNull();
  });
});

describe("buildSubscriptionOffers", () => {
  it("pairs each registry subscription with the key that connects it", () => {
    const copilot = credential({
      id: "copilot",
      provider: "github-copilot",
    });
    const offers = buildSubscriptionOffers([
      copilot,
      credential({ id: "plain-openai", provider: "openai" }),
    ]);

    expect(
      offers.map(({ kind, credential: connected }) => [
        kind,
        connected?.id ?? null,
      ]),
    ).toEqual([
      ["chatgpt", null],
      ["github-copilot", "copilot"],
      ["microsoft-365-copilot", null],
      ["x-premium", null],
    ]);
  });

  it("opens the connect dialog on the subscription tab only where one exists", () => {
    const offers = buildSubscriptionOffers([]);
    const byKind = Object.fromEntries(
      offers.map((offer) => [offer.kind, offer.defaultValues]),
    );

    // ChatGPT shares `openai` with ordinary API keys, so the form needs telling
    // which tab to open; GitHub Copilot has no tabs at all.
    expect(byKind.chatgpt).toMatchObject({
      provider: "openai",
      scope: "personal",
      authMethod: "subscription",
    });
    expect(byKind["github-copilot"]).not.toHaveProperty("authMethod");
  });
});
