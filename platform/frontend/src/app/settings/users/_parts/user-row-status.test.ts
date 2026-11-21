import { describe, expect, it } from "vitest";
import { deactivatedUserNote, pendingSignupLabel } from "./user-row-status";

describe("pendingSignupLabel", () => {
  it("names the identity provider for a user SCIM provisioned", () => {
    expect(pendingSignupLabel({ provider: null, scimProvisioned: true })).toBe(
      "Pending (identity provider)",
    );
  });

  it("names the messaging channel that auto-provisioned the user", () => {
    expect(
      pendingSignupLabel({ provider: "ms-teams", scimProvisioned: false }),
    ).toBe("Pending (MS Teams)");
    expect(
      pendingSignupLabel({ provider: "slack", scimProvisioned: false }),
    ).toBe("Pending (Slack)");
  });

  it("says only Pending when the source is unknown", () => {
    expect(pendingSignupLabel({ provider: null, scimProvisioned: false })).toBe(
      "Pending",
    );
  });
});

describe("deactivatedUserNote", () => {
  it("says when the user was deactivated and how to delete them", () => {
    expect(deactivatedUserNote("2026-11-21T12:00:00.000Z")).toBe(
      "Your identity provider deactivated this user on Nov 21, 2026. They can't sign in, but their data is kept. To delete them completely, choose Remove user in the row menu.",
    );
  });
});
