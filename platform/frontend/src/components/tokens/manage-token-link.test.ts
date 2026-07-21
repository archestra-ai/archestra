import { describe, expect, it } from "vitest";
import { getManageTokenLink } from "./manage-token-link";

describe("getManageTokenLink", () => {
  it("points a personal token at the account page's personal token card", () => {
    expect(
      getManageTokenLink({
        isPersonalTokenSelected: true,
        selectedTeamToken: null,
      }),
    ).toEqual({
      label: "Manage your personal token",
      href: "/account?highlight=personal-token",
    });
  });

  it("points the organization token at the organization settings card", () => {
    expect(
      getManageTokenLink({
        isPersonalTokenSelected: false,
        selectedTeamToken: { isOrganizationToken: true, team: null },
      }),
    ).toEqual({
      label: "Manage your organization token",
      href: "/settings/organization?highlight=organization-token",
    });
  });

  it("points a team token at that team's token dialog section", () => {
    expect(
      getManageTokenLink({
        isPersonalTokenSelected: false,
        selectedTeamToken: {
          isOrganizationToken: false,
          team: { id: "team-123" },
        },
      }),
    ).toEqual({
      label: "Manage your team token",
      href: "/settings/teams?team=team-123&section=token",
    });
  });

  it("falls back to the account page when nothing is selected", () => {
    expect(
      getManageTokenLink({
        isPersonalTokenSelected: false,
        selectedTeamToken: null,
      }),
    ).toEqual({
      label: "Manage your tokens",
      href: "/account?highlight=personal-token",
    });
  });
});
