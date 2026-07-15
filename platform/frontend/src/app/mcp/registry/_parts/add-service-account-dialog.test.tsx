import {
  E2eTestId,
  getManageCredentialsAddToTeamOptionTestId,
} from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddServiceAccountDialog } from "./add-service-account-dialog";

describe("AddServiceAccountDialog", () => {
  it("explains that the shared key is used as a static key or an on-behalf-of fallback", () => {
    render(
      <AddServiceAccountDialog
        open
        onOpenChange={() => {}}
        availableTeams={[]}
        canAddOrg
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/This connection is shared/i)).toBeInTheDocument();
    expect(screen.getByText("Static key")).toBeInTheDocument();
    expect(screen.getByText("Fallback")).toBeInTheDocument();
  });

  it("confirms an organization service account (the default when org is allowed)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <AddServiceAccountDialog
        open
        onOpenChange={() => {}}
        availableTeams={[{ id: "team-1", name: "Engineering" }]}
        canAddOrg
        onConfirm={onConfirm}
      />,
    );

    await user.click(
      screen.getByTestId(E2eTestId.AddServiceAccountConfirmButton),
    );

    expect(onConfirm).toHaveBeenCalledWith({ type: "org" });
  });

  it("confirms the specific team the user selects", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <AddServiceAccountDialog
        open
        onOpenChange={() => {}}
        availableTeams={[
          { id: "team-1", name: "Engineering" },
          { id: "team-2", name: "Sales" },
        ]}
        canAddOrg={false}
        onConfirm={onConfirm}
      />,
    );

    await user.click(
      screen.getByTestId(getManageCredentialsAddToTeamOptionTestId("Sales")),
    );
    await user.click(
      screen.getByTestId(E2eTestId.AddServiceAccountConfirmButton),
    );

    expect(onConfirm).toHaveBeenCalledWith({ type: "team", teamId: "team-2" });
  });

  it("disables confirmation when there is no team or organization to add", () => {
    render(
      <AddServiceAccountDialog
        open
        onOpenChange={() => {}}
        availableTeams={[]}
        canAddOrg={false}
        onConfirm={() => {}}
      />,
    );

    expect(
      screen.getByTestId(E2eTestId.AddServiceAccountConfirmButton),
    ).toBeDisabled();
  });
});
