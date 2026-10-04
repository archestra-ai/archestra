// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveLegacyAccountHref } from "./account-sections";

describe("resolveLegacyAccountHref", () => {
  it("leaves a plain /account visit alone", () => {
    expect(resolveLegacyAccountHref(null)).toBeNull();
  });

  it("sends an old ?section= link to the tab that replaced it", () => {
    expect(resolveLegacyAccountHref("sessions")).toBe("/account/sessions");
    expect(resolveLegacyAccountHref("api-keys")).toBe("/account/api-keys");
  });

  it.each([
    "permissions",
    "auth",
    "gateway-token",
    "two-factor",
    "nope",
  ])("keeps the %s section on the profile page", (section) => {
    // Permissions and auth were folded into Profile, so `/account` already
    // shows them; anything unknown also just renders Profile.
    expect(resolveLegacyAccountHref(section)).toBeNull();
  });
});
