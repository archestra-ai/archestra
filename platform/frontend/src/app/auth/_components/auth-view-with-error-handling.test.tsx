import { E2eTestId } from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSsoSignInAttempt,
  recordSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { usePublicConfig } from "@/lib/config/config.query";
import { AuthViewWithErrorHandling } from "./auth-view-with-error-handling";

vi.mock("./two-factor-view", () => ({
  TwoFactorView: () => <div data-testid="two-factor-view" />,
}));

vi.mock("./recover-account-view", () => ({
  RecoverAccountView: () => <div data-testid="recover-account-view" />,
}));

const mockSignInMutateAsync = vi.fn();

vi.mock("@/lib/auth/account.query", () => ({
  useSignInWithEmailMutation: () => ({
    mutateAsync: mockSignInMutateAsync,
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
  usePublicEnterpriseCoreActive: () => false,
}));

vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  usePublicIdentityProviders: () => ({ data: [] }),
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
      redirectUrl: "/",
    });
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

  it("renders the two-factor view for the two-factor path", () => {
    mockSearchParams.get.mockReturnValue(null);

    render(<AuthViewWithErrorHandling path="two-factor" />);

    expect(screen.getByTestId("two-factor-view")).toBeInTheDocument();
  });

  it("renders the recover-account view for the recover-account path", () => {
    mockSearchParams.get.mockReturnValue(null);

    render(<AuthViewWithErrorHandling path="recover-account" />);

    expect(screen.getByTestId("recover-account-view")).toBeInTheDocument();
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
});
