import { archestraApiSdk } from "@shared";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSsoSignInAttempt,
  recordSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { SignOutWithIdpLogout } from "./sign-out-with-idp-logout";

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getIdentityProviderIdpLogoutUrl: vi.fn(),
  },
}));

describe("SignOutWithIdpLogout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
    });
    vi.mocked(
      archestraApiSdk.getIdentityProviderIdpLogoutUrl,
    ).mockResolvedValue({
      data: { url: null },
    } as Awaited<
      ReturnType<typeof archestraApiSdk.getIdentityProviderIdpLogoutUrl>
    >);
  });

  it("clears stale SSO sign-in attempts during logout", async () => {
    recordSsoSignInAttempt();

    render(<SignOutWithIdpLogout />);

    await waitFor(() => {
      expect(hasSsoSignInAttempt()).toBe(false);
    });
  });
});
