import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OAuthReauthIndicator } from "./oauth-reauth-indicator";

describe("OAuthReauthIndicator", () => {
  it("surfaces the sanitized error code visibly and offers an actionable control", () => {
    const onActivate = vi.fn();
    render(
      <OAuthReauthIndicator
        errorMessage="invalid_grant"
        failedAt="2026-06-24T14:42:00.000Z"
        onActivate={onActivate}
      />,
    );

    expect(screen.getByText(/invalid_grant/i)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: /re-authenticat/i });
    action.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("shows the failure state but offers no action when re-auth is not permitted", () => {
    render(
      <OAuthReauthIndicator
        errorMessage="invalid_grant"
        failedAt="2026-06-24T14:42:00.000Z"
        onActivate={undefined}
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/invalid_grant/i)).toBeInTheDocument();
  });

  it("falls back to a generic reason when no error message is present", () => {
    render(
      <OAuthReauthIndicator
        errorMessage={null}
        failedAt={null}
        onActivate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /re-authenticat/i }),
    ).toBeInTheDocument();
  });
});
