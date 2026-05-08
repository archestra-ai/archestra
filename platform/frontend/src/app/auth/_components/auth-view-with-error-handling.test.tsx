import { E2eTestId } from "@shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSsoSignInAttempt,
  recordSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { usePublicConfig } from "@/lib/config/config.query";
import { AuthViewWithErrorHandling } from "./auth-view-with-error-handling";

vi.mock("@daveyplate/better-auth-ui", () => ({
  AuthView: () => <div data-testid="auth-view" />,
}));

const mockSignInMutateAsync = vi.fn();
const mockChangePasswordMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useSignInWithEmailMutation: () => ({
    mutateAsync: mockSignInMutateAsync,
    isPending: false,
  }),
  useChangeAccountPasswordMutation: () => ({
    mutateAsync: mockChangePasswordMutateAsync,
    isPending: false,
  }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: { core: false },
  },
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicConfig: vi.fn(),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Test App",
}));

vi.mock("./sign-out-with-idp-logout", () => ({
  SignOutWithIdpLogout: () => <div data-testid="sign-out" />,
}));

describe("AuthViewWithErrorHandling", () => {
  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSignInMutateAsync.mockResolvedValue({
      requiresDefaultPasswordChange: false,
      redirectUrl: "/",
    });
    mockChangePasswordMutateAsync.mockResolvedValue(true);
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/auth/sign-in");
    vi.mocked(useSearchParams).mockReturnValue(
      mockSearchParams as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePublicConfig).mockReturnValue({
      data: {
        disableBasicAuth: false,
        disableInvitations: false,
      },
      isLoading: false,
    } as ReturnType<typeof usePublicConfig>);
  });

  it("does not show a failed SSO message on first sign-in page load", () => {
    mockSearchParams.get.mockReturnValue(null);

    render(<AuthViewWithErrorHandling path="sign-in" callbackURL="/" />);

    expect(screen.queryByText("Sign-In Failed")).not.toBeInTheDocument();
    expect(
      screen.getByText("Enter your email below to login to your account"),
    ).toBeInTheDocument();
    expect(screen.getByTestId(E2eTestId.SignInSubmitButton)).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
  });

  it("shows a generic failed SSO message when the attempted callback returns to sign-in without an error query", async () => {
    const callbackURL =
      "/api/auth/oauth2/authorize?response_type=code&client_id=test&state=abc&exp=123&sig=old";
    recordSsoSignInAttempt();
    mockSearchParams.get.mockReturnValue(null);

    render(
      <AuthViewWithErrorHandling path="sign-in" callbackURL={callbackURL} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign-In Failed")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Single sign-on could not be completed. Please try again or contact your administrator.",
      ),
    ).toBeInTheDocument();
    expect(hasSsoSignInAttempt()).toBe(false);
  });

  it("shows the failed SSO message when Better Auth regenerates exp and sig", async () => {
    recordSsoSignInAttempt();
    mockSearchParams.get.mockReturnValue(null);

    render(
      <AuthViewWithErrorHandling
        path="sign-in"
        callbackURL="/api/auth/oauth2/authorize?response_type=code&client_id=test&state=abc&exp=456&sig=new"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign-In Failed")).toBeInTheDocument();
    });
  });

  it("keeps the generic failed SSO message visible under React Strict Mode", async () => {
    const callbackURL =
      "/api/auth/oauth2/authorize?response_type=code&client_id=test&state=strict";
    recordSsoSignInAttempt();
    mockSearchParams.get.mockReturnValue(null);

    render(
      <StrictMode>
        <AuthViewWithErrorHandling path="sign-in" callbackURL={callbackURL} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign-In Failed")).toBeInTheDocument();
    });
  });

  it("prompts for a new password after default admin sign-in", async () => {
    mockSearchParams.get.mockReturnValue(null);
    mockSignInMutateAsync.mockResolvedValue({
      requiresDefaultPasswordChange: true,
      redirectUrl: "/chat",
    });

    render(<AuthViewWithErrorHandling path="sign-in" callbackURL="/chat" />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Change Password")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-admin-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-admin-password" },
    });
    expect(screen.getByLabelText("New password")).toHaveValue(
      "new-admin-password",
    );
    expect(screen.getByLabelText("Confirm password")).toHaveValue(
      "new-admin-password",
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(mockChangePasswordMutateAsync).toHaveBeenCalledWith({
        currentPassword: "password",
        newPassword: "new-admin-password",
        revokeOtherSessions: true,
      });
    });
  });
});
