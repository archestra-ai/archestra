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

// These server pages no longer check access themselves; the client page guard
// mounted in the root layout refuses them. Rendered through that guard at
// their own path, so a missing or wrong `requiredPagePermissionsMap` entry
// shows the page to a reader the backend would refuse.

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
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
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
  });

  it.each(
    routes,
  )("$path shows the Forbidden page to a member without access", async ({
    path,
    page,
    refused,
  }) => {
    await renderAt({ path, page, permissions: refused });

    expect(screen.getByText(FORBIDDEN)).toBeVisible();
    expect(screen.queryByText(/Page content/)).not.toBeInTheDocument();
  });

  it.each(routes)("$path opens for an admin", async ({ path, page }) => {
    await renderAt({
      path,
      page,
      permissions: predefinedPermissionsMap.admin,
    });

    expect(screen.getByText(/Page content/)).toBeVisible();
    expect(screen.queryByText(FORBIDDEN)).not.toBeInTheDocument();
  });

  it("opens the agent chooser with creation enabled for a default member", async () => {
    await renderAt({
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

async function renderAt({
  path,
  page,
  permissions,
}: {
  path: string;
  page: () => Promise<ReactElement> | ReactElement;
  permissions: Permissions;
}) {
  vi.mocked(usePathname).mockReturnValue(path);
  const allows = (required: Permissions) =>
    hasPagePermissions({
      userPermissions: permissions,
      required,
      capabilities: [],
    });
  vi.mocked(usePermissionMap).mockImplementation((map) =>
    Object.fromEntries(
      Object.entries(map).map(([key, required]) => [key, allows(required)]),
    ),
  );
  vi.mocked(useHasPagePermissions).mockImplementation(
    (required) =>
      ({ data: allows(required), isPending: false }) as ReturnType<
        typeof useHasPagePermissions
      >,
  );
  const content = await page();
  render(<WithPagePermissions>{content}</WithPagePermissions>);
}
