import { describe, expect, it } from "vitest";
import { organizationSubscriptionName } from "./organization-subscription";

describe("organizationSubscriptionName", () => {
  it("shows the name the plan was given", () => {
    expect(
      organizationSubscriptionName({
        name: "Copilot for engineering",
        isGithubAppKey: true,
        githubOrganization: "acme",
      }),
    ).toBe("Copilot for engineering");
  });

  it("names a plan without a name of its own after its organization", () => {
    for (const name of [undefined, "", "GitHub Copilot (acme)"])
      expect(
        organizationSubscriptionName({
          name,
          isGithubAppKey: true,
          githubOrganization: "acme",
        }),
      ).toBe("GitHub Copilot · acme");
  });
});
