import { describe, expect, it } from "vitest";
import { resolveLegacyAccountHref } from "./account-sections";

describe("resolveLegacyAccountHref", () => {
  it("leaves a plain /account visit alone", () => {
    expect(
      resolveLegacyAccountHref({ section: null, highlight: null }),
    ).toBeNull();
  });

  it("sends an old ?section= link to the route that replaced it", () => {
    expect(
      resolveLegacyAccountHref({ section: "sessions", highlight: null }),
    ).toBe("/account/sessions");
  });

  it("sends the former account usage section to My Usage", () => {
    expect(
      resolveLegacyAccountHref({ section: "usage", highlight: null }),
    ).toBe("/llm/costs");
  });

  it("leaves an unknown section on the profile page rather than redirecting", () => {
    expect(
      resolveLegacyAccountHref({ section: "nope", highlight: null }),
    ).toBeNull();
  });

  it("routes the personal-token highlight to the gateway token page", () => {
    // The token dialog lives inside that card, so the card has to mount.
    expect(
      resolveLegacyAccountHref({ section: null, highlight: "personal-token" }),
    ).toBe("/account/gateway-token");
  });

  it("lets an explicit section win over the highlight", () => {
    expect(
      resolveLegacyAccountHref({
        section: "api-keys",
        highlight: "personal-token",
      }),
    ).toBe("/account/api-keys");
  });

  it("does not redirect the change-password highlight", () => {
    // Its button and dialog both sit in the layout, above the sections, so it
    // opens from whichever section is showing.
    expect(
      resolveLegacyAccountHref({ section: null, highlight: "change-password" }),
    ).toBeNull();
  });
});
