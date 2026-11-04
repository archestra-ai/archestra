import type { Permissions } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPagePermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { hasPagePermissions } from "@/lib/auth/auth.utils";
import { useTeamSpendAccess } from "@/lib/hooks/use-team-spend-access";
import { useTeamLimitAccess } from "@/lib/limits-access";
import { WithPagePermissions } from "./with-page-permissions";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/limits-access");
vi.mock("@/lib/hooks/use-team-spend-access");
// Read only when a grant on one credential might open Settings.
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({ data: [], isPending: false }),
}));

const replace = vi.fn();

function signInAs(userPermissions: Permissions | null) {
  vi.mocked(usePermissionMap).mockImplementation((map) =>
    userPermissions
      ? Object.fromEntries(
          Object.entries(map).map(([key, required]) => [
            key,
            hasPagePermissions({ userPermissions, required, capabilities: [] }),
          ]),
        )
      : null,
  );
  vi.mocked(useHasPagePermissions).mockImplementation(
    (required) =>
      ({
        data: userPermissions
          ? hasPagePermissions({ userPermissions, required, capabilities: [] })
          : false,
        isPending: userPermissions === null,
      }) as ReturnType<typeof useHasPagePermissions>,
  );
}

function renderAt(pathname: string) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  return render(
    <WithPagePermissions>
      <p>Page content</p>
    </WithPagePermissions>,
  );
}

describe("WithPagePermissions", () => {
  beforeEach(() => {
    vi.mocked(useTeamSpendAccess).mockImplementation(() => ({
      isTeamAdmin: useTeamLimitAccess().isTeamAdmin ?? false,
      isPending: useTeamLimitAccess().isPending ?? false,
      administeredTeamIds: useTeamLimitAccess().teams?.map((t) => t.id) ?? [],
    }));
    replace.mockClear();
    vi.mocked(useTeamLimitAccess).mockReturnValue({
      teams: [],
      managedTeams: [],
      isTeamAdmin: false,
      canRead: false,
      globalRead: false,
      globalCreate: false,
      isPending: false,
      allows: () => false,
      isLocked: () => true,
    });
    vi.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it.each([
    ["/settings", "/account"],
    ["/settings/credentials", "/account/credentials"],
    ["/settings/teams", "/account"],
    // A page the member could not open at all goes the same way, rather
    // than to the Forbidden page.
    ["/settings/users", "/account"],
  ])("sends a member from %s to %s without showing Settings", (pathname, destination) => {
    signInAs(predefinedPermissionsMap.member);
    renderAt(pathname);
    expect(replace).toHaveBeenCalledWith(destination);
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(screen.queryByText(/permission/i)).not.toBeInTheDocument();
  });

  it("keeps the query string when it sends a member to their credentials", () => {
    signInAs(predefinedPermissionsMap.member);
    window.history.pushState({}, "", "/settings/credentials?search=github");
    renderAt("/settings/credentials");
    expect(replace).toHaveBeenCalledWith("/account/credentials?search=github");
    window.history.pushState({}, "", "/");
  });

  it("keeps Settings for an editor", () => {
    signInAs(predefinedPermissionsMap.editor);
    renderAt("/settings/users");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows nothing until permissions load", () => {
    signInAs(null);
    renderAt("/settings/credentials");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    "/chat",
    "/chat/0b6f3c8e-6a49-4c47-9d0a-2c5b9d1d4e11",
  ])("renders %s while permissions load", (pathname) => {
    signInAs(null);
    renderAt(pathname);
    expect(screen.getByText("Page content")).toBeVisible();
  });

  it("keeps the other chat pages behind the check", () => {
    signInAs(null);
    renderAt("/chat/runs");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
  });

  it("swaps an optimistic chat for the Forbidden page without chat:read", () => {
    signInAs({ agent: ["read"] } as Permissions);
    renderAt("/chat");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeVisible();
  });

  it("keeps an admin on an Appearance subpage", () => {
    signInAs(predefinedPermissionsMap.admin);
    renderAt("/settings/appearance/branding");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows nothing on an Appearance subpage until permissions load", () => {
    signInAs(null);
    renderAt("/settings/appearance/chat");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("refuses an Appearance subpage without organization settings access", () => {
    // Users is enough to open Settings, but not Appearance.
    signInAs({ member: ["read"] } as Permissions);
    renderAt("/settings/appearance/branding");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeVisible();
  });

  it("leaves pages outside Settings to their own permission", () => {
    signInAs(predefinedPermissionsMap.member);
    renderAt("/account/credentials");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});

it("does not block an explicit cost reader on an unrelated team-membership query", () => {
  signInAs({ llmCost: ["read"] });
  vi.mocked(useTeamLimitAccess).mockReturnValue({
    ...useTeamLimitAccess(),
    isPending: true,
  });
  renderAt("/llm/costs");
  expect(screen.getByText("Page content")).toBeVisible();
});

it("allows a team admin into Costs without organization cost permission", () => {
  signInAs(predefinedPermissionsMap.member);
  vi.mocked(useTeamLimitAccess).mockReturnValue({
    ...useTeamLimitAccess(),
    isTeamAdmin: true,
    canRead: true,
    isPending: false,
  });
  renderAt("/llm/costs");
  expect(screen.getByText("Page content")).toBeVisible();
});

it("keeps ordinary members out of the Costs page", () => {
  signInAs(predefinedPermissionsMap.member);
  vi.mocked(useTeamLimitAccess).mockReturnValue({
    ...useTeamLimitAccess(),
    isTeamAdmin: false,
    canRead: false,
    isPending: false,
  });
  renderAt("/llm/costs");
  expect(
    screen.getByText("You don't have permission to access this page."),
  ).toBeVisible();
});

it("admits a team lead with no organization cost or team-directory permissions", () => {
  signInAs({});
  vi.mocked(useTeamSpendAccess).mockReturnValue({
    isTeamAdmin: true,
    isPending: false,
    administeredTeamIds: ["managed-team"],
  });
  renderAt("/llm/costs");
  expect(screen.getByText("Page content")).toBeVisible();
});
