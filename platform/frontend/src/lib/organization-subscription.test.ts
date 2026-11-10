import { describe, expect, it } from "vitest";
import { organizationSubscriptionName } from "./organization-subscription";

describe("organizationSubscriptionName", () => {
  it("names a plan after its GitHub organization, whatever its key is called", () => {
    for (const name of [undefined, "", "GitHub Copilot (acme)", "Copilot"])
      expect(
        organizationSubscriptionName({
          name,
          isGithubAppKey: true,
          githubOrganization: "acme",
        }),
      ).toBe("Github Copilot acme");
  });

  it("falls back to the plan's name when the organization is unknown", () => {
    expect(
      organizationSubscriptionName({
        name: "Copilot for engineering",
        isGithubAppKey: true,
        githubOrganization: null,
      }),
    ).toBe("Copilot for engineering");
    expect(organizationSubscriptionName({ isGithubAppKey: true })).toBe(
      "Github Copilot Organization",
    );
  });
});
