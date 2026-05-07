import { LINKED_IDP_SSO_MODE } from "@shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedIdentityProviderIntent } from "@/lib/auth/linked-idp";
import {
  getSsoSignInRedirectPath,
  hasSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { authClient } from "@/lib/clients/auth/auth-client";
import IdpInitiatedSsoPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    signIn: {
      sso: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/linked-idp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/linked-idp")>();
  return {
    ...actual,
    createLinkedIdentityProviderIntent: vi.fn(),
  };
});

describe("IdpInitiatedSsoPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com" },
      writable: true,
    });
    vi.mocked(useParams).mockReturnValue({ providerId: "Okta" });
    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as ReturnType<typeof useSearchParams>);
    vi.mocked(authClient.signIn.sso).mockResolvedValue(
      undefined as Awaited<ReturnType<typeof authClient.signIn.sso>>,
    );
    vi.mocked(createLinkedIdentityProviderIntent).mockResolvedValue({
      intentId: "intent-123",
      redirectTo: "/chat/conv-123",
    });
  });

  it("starts SSO for the provider in the route", async () => {
    render(<IdpInitiatedSsoPage />);

    await waitFor(() => {
      expect(authClient.signIn.sso).toHaveBeenCalledWith({
        providerId: "Okta",
        callbackURL: "https://app.example.com/",
        errorCallbackURL: "https://app.example.com/auth/sign-in",
      });
    });
    expect(hasSsoSignInAttempt()).toBe(true);
    expect(getSsoSignInRedirectPath()).toBe("/");
  });

  it("uses a safe redirectTo value as callback URL", async () => {
    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key: string) =>
        key === "redirectTo" ? encodeURIComponent("/chat") : null,
      ),
    } as unknown as ReturnType<typeof useSearchParams>);

    render(<IdpInitiatedSsoPage />);

    await waitFor(() => {
      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: "https://app.example.com/chat",
        }),
      );
    });
    expect(getSsoSignInRedirectPath()).toBe("/chat");
  });

  it("creates a link intent before starting linked identity provider SSO", async () => {
    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === "redirectTo") return encodeURIComponent("/chat/conv-123");
        if (key === "mode") return LINKED_IDP_SSO_MODE;
        return null;
      }),
    } as unknown as ReturnType<typeof useSearchParams>);

    render(<IdpInitiatedSsoPage />);

    await waitFor(() => {
      expect(createLinkedIdentityProviderIntent).toHaveBeenCalledWith({
        providerId: "Okta",
        redirectTo: "/chat/conv-123",
      });
      expect(authClient.signIn.sso).toHaveBeenCalledWith({
        providerId: "Okta",
        callbackURL:
          "https://app.example.com/auth/sso/linked-callback?intentId=intent-123&redirectTo=%2Fchat%2Fconv-123",
        errorCallbackURL: "https://app.example.com/auth/sign-in",
      });
    });
    expect(hasSsoSignInAttempt()).toBe(false);
  });

  it("retries SSO when the initial request fails", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.signIn.sso)
      .mockRejectedValueOnce(new Error("SSO failed"))
      .mockResolvedValueOnce(
        undefined as Awaited<ReturnType<typeof authClient.signIn.sso>>,
      );

    render(<IdpInitiatedSsoPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try Again" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Try Again" }));

    await waitFor(() => {
      expect(authClient.signIn.sso).toHaveBeenCalledTimes(2);
    });
  });
});
