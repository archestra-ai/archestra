import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppTeamAccessWarning } from "./app-team-access-warning";

describe("AppTeamAccessWarning", () => {
  it("warns an app administrator outside every selected team", () => {
    render(
      <AppTeamAccessWarning
        scope="team"
        selectedTeamIds={["leadership"]}
        isAppAdmin
        userTeamIds={new Set(["engineering"])}
      />,
    );

    expect(
      screen.getByText("You are not a member of the selected teams."),
    ).toBeVisible();
    expect(
      screen.getByText(/will not be able to modify this app through chat/i),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveClass("py-1.5", "text-xs");
  });

  it("does not warn when the administrator belongs to a selected team", () => {
    render(
      <AppTeamAccessWarning
        scope="team"
        selectedTeamIds={["engineering", "leadership"]}
        isAppAdmin
        userTeamIds={new Set(["engineering"])}
      />,
    );

    expect(
      screen.queryByText("You are not a member of the selected teams."),
    ).not.toBeInTheDocument();
  });

  it("does not warn non-admins or non-team visibility", () => {
    const { rerender } = render(
      <AppTeamAccessWarning
        scope="team"
        selectedTeamIds={["leadership"]}
        isAppAdmin={false}
        userTeamIds={new Set()}
      />,
    );

    expect(
      screen.queryByText("You are not a member of the selected teams."),
    ).not.toBeInTheDocument();

    rerender(
      <AppTeamAccessWarning
        scope="org"
        selectedTeamIds={["leadership"]}
        isAppAdmin
        userTeamIds={new Set()}
      />,
    );
    expect(
      screen.queryByText("You are not a member of the selected teams."),
    ).not.toBeInTheDocument();
  });
});
