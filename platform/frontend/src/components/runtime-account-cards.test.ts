// @vitest-environment node
import { describe, expect, it } from "vitest";
import { personalSubscriptionCard } from "./runtime-account-cards";

describe("personalSubscriptionCard", () => {
  it("names the subscription by the provider, in its title and in whose account it is", () => {
    const card = personalSubscriptionCard("chatgpt");
    expect(card.title).toBe("Each person's ChatGPT subscription");
    // The account is the provider's: "ChatGPT account", not "ChatGPT
    // Subscription account".
    expect(card.description).toBe(
      "Everyone connects their own ChatGPT account once. Not billed to the company, no cost limits. A run's container only gets a short-lived key.",
    );
  });
});
