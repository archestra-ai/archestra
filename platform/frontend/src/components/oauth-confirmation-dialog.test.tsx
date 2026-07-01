import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConfirmationDialog } from "./oauth-confirmation-dialog";

// Simulate a catalog item that is already installed everywhere the caller can
// install it — the real selector reports canInstall=false and renders the
// "Already installed" notice in that situation.
vi.mock(
  "@/app/mcp/registry/_parts/select-mcp-server-credential-type-and-teams",
  () => ({
    SelectMcpServerCredentialTypeAndTeams: ({
      onCanInstallChange,
    }: {
      onCanInstallChange: (value: boolean) => void;
    }) => {
      useEffect(() => {
        onCanInstallChange(false);
      }, [onCanInstallChange]);
      return (
        <div data-testid="credential-type-selector">Already installed</div>
      );
    },
  }),
);

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

describe("OAuthConfirmationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks installing a server that is already installed everywhere", () => {
    render(
      <OAuthConfirmationDialog
        open
        onOpenChange={vi.fn()}
        serverName="PLAY"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        catalogId="catalog-1"
      />,
    );

    // Install mode renders the scope selector, which reports "already installed"
    // and removes the "Continue to Authorization" action.
    expect(screen.getByTestId("credential-type-selector")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue to authorization/i }),
    ).not.toBeInTheDocument();
  });

  it("lets the user re-authorize an already-installed connection", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <OAuthConfirmationDialog
        open
        onOpenChange={vi.fn()}
        serverName="PLAY"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        catalogId="catalog-1"
        isReauth
      />,
    );

    // Re-auth keeps the existing scope, so the selector (and its dead-end
    // "Already installed" state) is skipped and the user can proceed.
    expect(
      screen.queryByTestId("credential-type-selector"),
    ).not.toBeInTheDocument();

    const continueButton = screen.getByRole("button", {
      name: /continue to authorization/i,
    });
    expect(continueButton).toBeInTheDocument();

    await user.click(continueButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
