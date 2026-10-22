import type { Permissions } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPagePermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { hasPagePermissions } from "@/lib/auth/auth.utils";
import { WithPagePermissions } from "./with-page-permissions";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
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
    replace.mockClear();
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

  it("leaves pages outside Settings to their own permission", () => {
    signInAs(predefinedPermissionsMap.member);
    renderAt("/account/credentials");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});
