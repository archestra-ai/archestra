import type { Permissions } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAllPermissions,
  usePermissionMap,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
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
  vi.mocked(useAllPermissions).mockReturnValue({
    data: userPermissions ?? undefined,
    isPending: userPermissions === null,
  } as ReturnType<typeof useAllPermissions>);
  capabilitiesLoaded(true);
}

function capabilitiesLoaded(loaded: boolean) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: loaded ? [] : undefined,
    isPending: !loaded,
  } as unknown as ReturnType<typeof useScopedCapabilities>);
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

  it("does not wait for object grants on a page whose permission has none", () => {
    signInAs(predefinedPermissionsMap.admin);
    capabilitiesLoaded(false);
    renderAt("/audit/logs");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(useScopedCapabilities).toHaveBeenCalledWith(false);
  });

  it("waits for object grants on a page they can open", () => {
    signInAs({});
    capabilitiesLoaded(false);
    renderAt("/agents");
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    expect(screen.queryByText(/permission/i)).not.toBeInTheDocument();
    expect(useScopedCapabilities).toHaveBeenCalledWith(true);
  });

  it("leaves pages outside Settings to their own permission", () => {
    signInAs(predefinedPermissionsMap.member);
    renderAt("/account/credentials");
    expect(screen.getByText("Page content")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});
