import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAllPermissions,
  useHasPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";
import {
  useEnterpriseFeature,
  usePublicConfig,
} from "@/lib/config/config.query";
import { useActiveMemberRole, useOrganization } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { useRotateUserToken, useUserToken } from "@/lib/user-token.query";
import AccountProfilePage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/auth/permission-sources.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/user-token.query");
vi.mock("@/lib/auth/two-factor.query", () => ({
  useDisableTwoFactorMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useChangeAccountPasswordMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

const replace = vi.fn();

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountProfilePage />
    </QueryClientProvider>,
  );
}

function setSearch(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

describe("AccountProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    setSearch("");
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: { id: "u1", name: "Ada", email: "ada@example.com" },
        session: { activeOrganizationId: "org-1" },
      },
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useAllPermissions).mockReturnValue({
      data: {},
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAllPermissions>);
    vi.mocked(usePermissionSources).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof usePermissionSources>);
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    vi.mocked(usePublicConfig).mockReturnValue({
      data: { disableBasicAuth: false },
      isLoading: false,
    } as unknown as ReturnType<typeof usePublicConfig>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { requireTwoFactor: false },
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: "member",
      isPending: false,
    } as unknown as ReturnType<typeof useActiveMemberRole>);
    vi.mocked(useMyTeams).mockReturnValue({
      data: [{ id: "t1", name: "Platform", myRole: "member", members: [] }],
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMyTeams>);
    vi.mocked(useUserToken).mockReturnValue({
      data: { id: "tok-1", tokenStart: "arch_abc" },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useUserToken>);
    vi.mocked(useRotateUserToken).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useRotateUserToken>);
  });

  it("puts profile, access and sign-in & security on one page, in that order", () => {
    renderPage();

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Profile", "Access", "Sign-in & security"]);

    expect(screen.getByText("Ada")).toBeVisible();
    expect(screen.getByText("Platform")).toBeVisible();
    // What used to be the Auth route is now rows under Sign-in & security,
    // and the password lives there too rather than in the page header.
    expect(screen.getByRole("button", { name: "Change" })).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Two-factor authentication" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage" })).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it("hides the password row when the deployment does not use passwords", () => {
    vi.mocked(usePublicConfig).mockReturnValue({
      data: { disableBasicAuth: true },
      isLoading: false,
    } as unknown as ReturnType<typeof usePublicConfig>);

    renderPage();

    expect(screen.queryByText("Password")).toBeNull();
  });

  it("opens Change password from the default-credentials deep link", async () => {
    setSearch("highlight=change-password");

    renderPage();

    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("forwards an old ?section= link to the tab that replaced it", () => {
    setSearch("section=sessions");

    renderPage();

    expect(replace).toHaveBeenCalledWith("/account/sessions?section=sessions");
  });

  it("opens the gateway token dialog from an old token deep link without leaving Profile", async () => {
    setSearch("section=gateway-token&highlight=personal-token");

    renderPage();

    expect(replace).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeVisible();
  });
});
