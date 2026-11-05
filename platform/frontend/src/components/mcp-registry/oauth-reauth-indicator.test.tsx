import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OAuthReauthIndicator } from "./oauth-reauth-indicator";

describe("OAuthReauthIndicator", () => {
  it("is a single clickable target that activates from anywhere in it", () => {
    const onActivate = vi.fn();
    render(<OAuthReauthIndicator onActivate={onActivate} />);

    // The whole indicator is the click target — clicking the label (not a
    // dedicated sub-control) must activate it.
    screen.getByText(/needs re-authentication/i).click();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("shows the state but offers no action when re-auth is not permitted", () => {
    render(<OAuthReauthIndicator onActivate={undefined} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/needs re-authentication/i)).toBeInTheDocument();
  });

  it("keeps the card marker free of error detail (detail lives on the connections surface)", () => {
    render(<OAuthReauthIndicator onActivate={vi.fn()} />);

    expect(screen.queryByText(/invalid_grant/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});
