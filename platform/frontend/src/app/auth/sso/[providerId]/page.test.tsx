// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { LINKED_IDP_SSO_MODE } from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLinkedIdentityProviderIntent } from "@/lib/auth/linked-idp";
import {
  getSsoSignInRedirectPath,
  hasSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { authClient } from "@/lib/clients/auth/auth-client";
import IdpInitiatedSsoPage from "./page";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

vi.mock("sonner");
vi.mock("next/navigation");

vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));

vi.mock("@/lib/clients/auth/auth-client");

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
    vi.mocked(authClient.signIn.sso)
      .mockReset()
      .mockResolvedValue({
        data: { url: "https://idp.example.com/authorize", redirect: true },
        error: null,
      });
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

  it("shows the error and allows retry after an HTTP error response", async () => {
    let attempts = 0;
    server.use(
      http.post(`${window.location.origin}/api/auth/sign-in/sso`, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(
              { code: "discovery_not_found", message: "Discovery failed" },
              { status: 400 },
            )
          : HttpResponse.json({ url: null, redirect: false });
      }),
    );
    const { authClient: realAuthClient } = await vi.importActual<
      typeof import("@/lib/clients/auth/auth-client")
    >("@/lib/clients/auth/auth-client");
    vi.mocked(authClient.signIn.sso).mockImplementation((params) =>
      realAuthClient.signIn.sso(params),
    );
    const user = userEvent.setup();

    render(<IdpInitiatedSsoPage />);

    const retry = await screen.findByRole("button", { name: "Try Again" });
    await expect(
      vi.mocked(authClient.signIn.sso).mock.results[0].value,
    ).resolves.toMatchObject({
      error: { status: 400 },
    });
    expect(toast.error).toHaveBeenCalledWith("Failed to initiate SSO sign-in");
    await user.click(retry);

    await waitFor(() => expect(attempts).toBe(2));
    await expect(
      vi.mocked(authClient.signIn.sso).mock.results[1].value,
    ).resolves.toMatchObject({ error: null });
    expect(
      screen.queryByRole("button", { name: "Try Again" }),
    ).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("retries SSO when the initial request fails", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.signIn.sso)
      .mockRejectedValueOnce(new Error("SSO failed"))
      .mockResolvedValueOnce({
        data: { url: "https://idp.example.com/authorize", redirect: true },
        error: null,
      });

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
