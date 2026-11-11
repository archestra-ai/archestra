import { describe, expect, it } from "vitest";
import {
  copilotCredentialSourceLabel,
  organizationSubscriptionName,
  organizationSubscriptionSubtitle,
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

  it("uses the name GitHub shows for the organization over its login", () => {
    const plan = {
      isGithubAppKey: true,
      githubOrganization: "archestra-ai",
      githubOrganizationName: "Archestra",
    };
    expect(organizationSubscriptionName(plan)).toBe("GitHub Copilot Archestra");
    expect(organizationSubscriptionSubtitle(plan)).toBe(
      "Billed to Archestra on GitHub",
    );
    // An organization without a name on GitHub keeps its login.
    expect(
      organizationSubscriptionName({
        ...plan,
        githubOrganizationName: null,
      }),
    ).toBe("GitHub Copilot archestra-ai");
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
        organization: "archestra-ai",
        organizationName: "Archestra",
      }),
    ).toBe("GitHub Copilot Archestra");
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
