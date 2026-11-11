import { describe, expect, it } from "vitest";
import {
  copilotCredentialSourceLabel,
  organizationSubscriptionName,
} from "./organization-subscription";

describe("organizationSubscriptionName", () => {
  it("names a plan after its GitHub organization, whatever its key is called", () => {
    expect(
      organizationSubscriptionName(
        { isGithubAppKey: true, githubOrganization: "acme" },
        "Copilot for engineering",
      ),
    ).toBe("GitHub Copilot acme");
  });

  it("falls back to the plan's name from Settings when the organization is unknown", () => {
    expect(
      organizationSubscriptionName(
        { isGithubAppKey: true, githubOrganization: null },
        "Copilot for engineering",
      ),
    ).toBe("Copilot for engineering");
    expect(organizationSubscriptionName({ isGithubAppKey: true })).toBe(
      "GitHub Copilot Organization",
    );
  });
});

describe("copilotCredentialSourceLabel", () => {
  it("names a plan in the logs as every picker does", () => {
    expect(
      copilotCredentialSourceLabel({
        kind: "organization",
        organization: "acme",
      }),
    ).toBe("GitHub Copilot acme");
    expect(
      copilotCredentialSourceLabel({
        kind: "organization",
        organization: null,
      }),
    ).toBe("GitHub Copilot Organization");
    expect(
      copilotCredentialSourceLabel(
        { kind: "organization", organization: null },
        "Copilot for engineering",
      ),
    ).toBe("Copilot for engineering");
    expect(copilotCredentialSourceLabel({ kind: "personal" })).toBe(
      "Personal sign-in",
    );
  });
});
