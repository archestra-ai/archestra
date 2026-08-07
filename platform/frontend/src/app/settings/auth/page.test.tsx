"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses Popper and pointer capture APIs that jsdom does not provide.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mutateAsync = vi.fn();

let mockOrganization: Record<string, unknown> | null = null;
let mockOrganizationPending = false;

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("next/navigation");

vi.mock("@/lib/role.query", () => ({
  useRoles: vi.fn(() => ({
    data: [
      {
        id: "role-member",
        role: "member",
        name: "member",
        predefined: true,
        permission: {},
      },
      {
        id: "role-admin",
        role: "admin",
        name: "admin",
        predefined: true,
        permission: {},
      },
    ],
    isPending: false,
  })),
}));

vi.mock("@/lib/teams/team-token.query", () => ({
  useTokens: vi.fn(() => ({
    data: { tokens: [] },
    isLoading: false,
    error: null,
  })),
}));

import { useSearchParams } from "next/navigation";
import {
  useAllPermissions,
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useEnterpriseFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useOrganization,
  useUpdateAuthSettings,
} from "@/lib/organization.query";
// biome-ignore lint/style/noRestrictedImports: asserts the dual-licensed RUM teardown; inert without the feature
import { rumClient } from "@/lib/rum.ee";
import AuthSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthSettingsPage />
    </QueryClientProvider>,
  );
}

describe("AuthSettingsPage", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1", twoFactorEnabled: true } },
    } as unknown as ReturnType<typeof useSession>);
    vi.clearAllMocks();
    mockOrganization = {
      oauthAccessTokenLifetimeSeconds: 31_536_000,
      sessionMaxAgeSeconds: null,
      requireTwoFactor: false,
      defaultMemberRole: null,
    };
    mockOrganizationPending = false;
    mutateAsync.mockImplementation(async (body: Record<string, unknown>) => ({
      ...mockOrganization,
      ...body,
    }));

    vi.mocked(useOrganization).mockImplementation(
      () =>
        ({
          data: mockOrganization,
          isPending: mockOrganizationPending,
        }) as ReturnType<typeof useOrganization>,
    );
    vi.mocked(useUpdateAuthSettings).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateAuthSettings>);
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    vi.mocked(useSmallTeamTier).mockReturnValue(
      undefined as ReturnType<typeof useSmallTeamTier>,
    );
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useMissingPermissions).mockReturnValue(
      [] as unknown as ReturnType<typeof useMissingPermissions>,
    );
    vi.mocked(useAllPermissions).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useAllPermissions>);
  });

  it("submits a preset OAuth token lifetime", async () => {
    const user = userEvent.setup();

    renderPage();

    const select = screen.getByRole("combobox", { name: /token lifetime/i });
    expect(select).toHaveTextContent("1 year");

    await user.click(select);
    await user.click(screen.getByRole("option", { name: "7 days" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        oauthAccessTokenLifetimeSeconds: 604_800,
      });
    });
  });

  it("submits a custom OAuth token lifetime", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("combobox", { name: /token lifetime/i }));
    await user.click(screen.getByRole("option", { name: "Custom lifetime" }));

    const input = screen.getByLabelText(/custom lifetime in seconds/i);
    await user.clear(input);
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        oauthAccessTokenLifetimeSeconds: 123_456,
      });
    });
  });

  it("saves every dirty auth field in a single PATCH", async () => {
    const user = userEvent.setup();

    renderPage();

    // OAuth token lifetime: 1 year -> 7 days
    await user.click(screen.getByRole("combobox", { name: /token lifetime/i }));
    await user.click(screen.getByRole("option", { name: "7 days" }));

    // Require 2FA: off -> on
    await user.click(screen.getByRole("switch"));

    // Session lifetime: no limit -> 24 hours
    await user.click(
      screen.getByRole("combobox", { name: /maximum session lifetime/i }),
    );
    await user.click(screen.getByRole("option", { name: "24 hours" }));

    // Default role: member -> admin
    await user.click(screen.getByTestId("default-member-role-select"));
    await user.click(screen.getByRole("option", { name: /admin/i }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(mutateAsync).toHaveBeenCalledWith({
        oauthAccessTokenLifetimeSeconds: 604_800,
        sessionMaxAgeSeconds: 86_400,
        requireTwoFactor: true,
        defaultMemberRole: "admin",
      });
    });
  });

  it("discards changes without saving when cancelled", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("combobox", { name: /token lifetime/i }));
    await user.click(screen.getByRole("option", { name: "7 days" }));

    // Cancel is a native submit button inside the page form; the submit
    // handler must diff the reset values and skip the PATCH entirely.
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: /token lifetime/i }),
    ).toHaveTextContent("1 year");
  });

  it("hides the enterprise-only sections without a license", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);

    renderPage();

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /maximum session lifetime/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the default preset when the organization response is missing the lifetime", () => {
    mockOrganization = {};

    renderPage();

    expect(
      screen.getByRole("combobox", { name: /token lifetime/i }),
    ).toHaveTextContent("1 year");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("does not show the one year fallback while the organization is loading", () => {
    mockOrganization = null;
    mockOrganizationPending = true;

    renderPage();

    expect(
      screen.getByRole("combobox", { name: /token lifetime/i }),
    ).not.toHaveTextContent("1 year");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("signs the non-enrolled admin out after enforcing 2FA, resetting RUM first", async () => {
    // Enforcing 2FA revokes this admin's own session because they have not
    // enrolled — the page must tear down RUM state and sign out cleanly.
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1", twoFactorEnabled: false } },
    } as unknown as ReturnType<typeof useSession>);
    Object.defineProperty(window, "location", {
      value: { assign: vi.fn() },
      writable: true,
    });
    const resetSpy = vi.spyOn(rumClient, "reset").mockImplementation(() => {});
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ requireTwoFactor: true });
      expect(window.location.assign).toHaveBeenCalledWith("/auth/sign-in");
    });
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    // The flush inside reset() rides the still-valid session cookie, so it
    // must land before signOut revokes the session.
    expect(resetSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authClient.signOut).mock.invocationCallOrder[0],
    );

    resetSpy.mockRestore();
  });
});
