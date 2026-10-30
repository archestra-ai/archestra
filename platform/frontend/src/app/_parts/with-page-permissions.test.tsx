import "@/lib/limits-access";
import type { Permissions } from "@archestra/shared";
import {
  memberPermissions,
  predefinedPermissionsMap,
} from "@archestra/shared/access-control";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import A2aRemoteAgentDetailPageServer from "@/app/agents/a2a/[id]/page";
import NewA2aRemoteAgentPageServer from "@/app/agents/a2a/new/page";
import NewAgentPageServer from "@/app/agents/new/page";
import NewMcpCatalogItemPageServer from "@/app/mcp/registry/new/page";
import { useHasPagePermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { hasPagePermissions } from "@/lib/auth/auth.utils";
import { WithPagePermissions } from "./with-page-permissions";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/limits-access");
// Read only when a grant on one credential might open Settings.
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({ data: [], isPending: false }),
}));

vi.mock("@/app/mcp/registry/new/page.client", () => ({
  default: () => <p>Page content</p>,
}));
vi.mock("@/components/agent-pages/agent-create-page", () => ({
  AgentCreatePage: ({ canCreateAgent }: { canCreateAgent: boolean }) => (
    <p data-can-create-agent={String(canCreateAgent)}>Page content</p>
  ),
}));
vi.mock("@/components/a2a-remote-agent-page", () => ({
  CreateA2aRemoteAgentPage: () => <p>Page content</p>,
  A2aRemoteAgentDetailPage: () => <p>Page content</p>,
}));

const replace = vi.fn();

beforeEach(() => {
  replace.mockClear();
  vi.mocked(useRouter).mockReturnValue({
    replace,
  } as unknown as ReturnType<typeof useRouter>);
});

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

const FORBIDDEN = "You don't have permission to access this page.";

const without = (resource: keyof Permissions, action: string): Permissions => ({
  ...memberPermissions,
  [resource]: memberPermissions[resource].filter((a) => a !== action),
});

const routes: Array<{
  path: string;
  page: () => Promise<ReactElement> | ReactElement;
  /** A member who may not open this page. */
  refused: Permissions;
}> = [
  {
    path: "/mcp/registry/new",
    page: NewMcpCatalogItemPageServer,
    // The default member reads the registry but cannot add to it.
    refused: memberPermissions,
  },
  {
    path: "/agents/new",
    page: NewAgentPageServer,
    refused: without("agent", "create"),
  },
  {
    path: "/agents/a2a/new",
    page: NewA2aRemoteAgentPageServer,
    refused: without("agent", "read"),
  },
  {
    path: "/agents/a2a/agent-1",
    page: () =>
      A2aRemoteAgentDetailPageServer({
        params: Promise.resolve({ id: "agent-1" }),
      }),
    refused: without("agent", "read"),
  },
];

describe("routes refused by the client page guard", () => {
  it.each(
    routes,
  )("$path shows the Forbidden page to a member without access", async ({
    path,
    page,
    refused,
  }) => {
    await renderPageAt({ path, page, permissions: refused });

    expect(screen.getByText(FORBIDDEN)).toBeVisible();
    expect(screen.queryByText(/Page content/)).not.toBeInTheDocument();
  });

  it.each(routes)("$path opens for an admin", async ({ path, page }) => {
    await renderPageAt({
      path,
      page,
      permissions: predefinedPermissionsMap.admin,
    });

    expect(screen.getByText(/Page content/)).toBeVisible();
    expect(screen.queryByText(FORBIDDEN)).not.toBeInTheDocument();
  });

  it("opens the agent chooser with creation enabled for a default member", async () => {
    await renderPageAt({
      path: "/agents/new",
      page: NewAgentPageServer,
      permissions: memberPermissions,
    });

    expect(screen.getByText("Page content")).toHaveAttribute(
      "data-can-create-agent",
      "true",
    );
  });
});

async function renderPageAt({
  path,
  page,
  permissions,
}: {
  path: string;
  page: () => Promise<ReactElement> | ReactElement;
  permissions: Permissions;
}) {
  vi.mocked(usePathname).mockReturnValue(path);
  signInAs(permissions);
  render(<WithPagePermissions>{await page()}</WithPagePermissions>);
}
