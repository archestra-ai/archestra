import { describe, expect, it } from "vitest";
import { resolveAccountSection } from "./account-sections";

describe("resolveAccountSection", () => {
  it("defaults to the profile section", () => {
    expect(resolveAccountSection({ section: null, highlight: null })).toBe(
      "profile",
    );
  });

  it("honours a deep-linked section", () => {
    expect(
      resolveAccountSection({ section: "sessions", highlight: null }),
    ).toBe("sessions");
  });

  it("falls back to profile for an unknown section", () => {
    expect(resolveAccountSection({ section: "nope", highlight: null })).toBe(
      "profile",
    );
  });

  it("opens the gateway-token section for the personal-token highlight", () => {
    // The token dialog lives inside that card, so the card has to mount.
    expect(
      resolveAccountSection({ section: null, highlight: "personal-token" }),
    ).toBe("gateway-token");
  });

  it("lets an explicit section win over the highlight", () => {
    expect(
      resolveAccountSection({
        section: "api-keys",
        highlight: "personal-token",
      }),
    ).toBe("api-keys");
  });

  it("leaves the change-password highlight on the default section", () => {
    // Its button and dialog both sit on the page above the sections, so it
    // opens from whichever section is showing.
    expect(
      resolveAccountSection({ section: null, highlight: "change-password" }),
    ).toBe("profile");
  });
});
