import { archestraApiSdk } from "@archestra/shared";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSsoSignInAttempt,
  recordSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import { rumClient } from "@/lib/rum.ee";
import { SignOutWithIdpLogout } from "./sign-out-with-idp-logout";

vi.mock("@archestra/shared", () => ({
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

  it("resets RUM telemetry before the session is revoked", async () => {
    const resetSpy = vi.spyOn(rumClient, "reset").mockImplementation(() => {});

    render(<SignOutWithIdpLogout />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/sign-out",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(resetSpy).toHaveBeenCalledTimes(1);
    // reset() flushes pending events same-origin, so it must run while the
    // session cookie is still valid — before the sign-out POST revokes it.
    expect(resetSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetch).mock.invocationCallOrder[0],
    );

    resetSpy.mockRestore();
  });
});
