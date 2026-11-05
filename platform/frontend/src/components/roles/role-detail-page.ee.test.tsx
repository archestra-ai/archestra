import { archestraApiClient } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
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
import type { SettingsPageHeader } from "@/components/settings/settings-layout.context";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { RoleDetailPage } from "./role-detail-page.ee";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");

const layout = vi.hoisted(() => ({
  setPageHeader: vi.fn(),
  setActionButton: vi.fn(),
}));
vi.mock("@/components/settings/settings-layout.context", () => ({
  useSetSettingsPageHeader: () => layout.setPageHeader,
  useSetSettingsAction: () => layout.setActionButton,
}));

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

const customRole = {
  id: "role-1",
  name: "Reviewer",
  role: "reviewer",
  description: "Reads everything, changes nothing.",
  predefined: false,
  permission: { agent: ["read"], chat: ["read"] },
  organizationId: "org-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const adminRole = {
  ...customRole,
  id: "admin",
  name: "admin",
  role: "admin",
  description: null,
  predefined: true,
  permission: predefinedPermissionsMap.admin,
};

const page = (body: object) => ({
  data: [],
  pagination: {
    currentPage: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
  ...body,
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  layout.setPageHeader.mockClear();
  layout.setActionButton.mockClear();
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);
  server.use(
    http.get(`${API_ORIGIN}/api/roles/:roleId`, ({ params }) =>
      HttpResponse.json(params.roleId === "admin" ? adminRole : customRole),
    ),
    http.get(`${API_ORIGIN}/api/teams`, () => HttpResponse.json([])),
    http.get(`${API_ORIGIN}/api/service-accounts`, () => HttpResponse.json([])),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderPage(roleId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RoleDetailPage roleId={roleId} />, { wrapper });
}

/** The header the page last handed the settings layout. */
function lastHeader(): SettingsPageHeader {
  return layout.setPageHeader.mock.lastCall?.[0];
}

/** The page's action buttons, rendered on their own so they can be queried. */
function renderActions() {
  const node = layout.setActionButton.mock.lastCall?.[0];
  return render(<>{node}</>);
}

describe("RoleDetailPage", () => {
  it("shows the granted permissions of the role", async () => {
    renderPage("role-1");
    const agents = await screen.findByRole("region", { name: "Agents" });
    expect(within(agents).getByText("View agents")).toBeVisible();
    expect(within(agents).queryByText("Create agents")).toBeNull();
    expect(screen.queryByRole("region", { name: "Skills" })).toBeNull();
    expect(lastHeader().documentTitle).toBe("Reviewer");
    expect(lastHeader().description).toBe("Reads everything, changes nothing.");
  });

  it("a custom role's Edit opens the edit page and its menu offers Delete", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    renderPage("role-1");
    await screen.findByRole("region", { name: "Agents" });
    const actions = renderActions();
    const edit = within(actions.container).getByRole("button", {
      name: "Edit",
    });
    expect(edit).toBeEnabled();
    edit.click();
    expect(push).toHaveBeenCalledWith("/settings/roles/role-1/edit");
  });

  it("a built-in role cannot be edited, only started from", async () => {
    renderPage("admin");
    await screen.findByRole("region", { name: "Agents" });
    const actions = renderActions();
    expect(
      within(actions.container).getByRole("button", { name: "Edit" }),
    ).toBeDisabled();
    expect(lastHeader().documentTitle).toBe("admin");
    // Built-in roles carry the shared description, not an empty line.
    expect(lastHeader().description).toMatch(/Full access/);
  });

  it("lists the users holding the role directly, above the permissions", async () => {
    let roleFilter: string | null = null;
    server.use(
      http.get(`${API_ORIGIN}/api/members`, ({ request }) => {
        roleFilter = new URL(request.url).searchParams.get("role");
        return HttpResponse.json(
          page({
            data: [
              {
                id: "m1",
                userId: "u1",
                name: "Ada Lovelace",
                email: "ada@example.test",
                image: null,
                role: "reviewer",
                createdAt: "2026-01-01T00:00:00.000Z",
                twoFactorEnabled: false,
              },
            ],
            pagination: {
              currentPage: 1,
              limit: 20,
              total: 1,
              totalPages: 1,
              hasNext: false,
              hasPrev: false,
            },
          }),
        );
      }),
    );
    renderPage("role-1");
    // No team or service account holds it, so the Users tile opens by itself.
    const users = await screen.findByRole("tab", { name: /Users/ });
    await waitFor(() => expect(users).toHaveAttribute("aria-selected", "true"));
    const panel = screen.getByRole("tabpanel");
    await waitFor(() =>
      expect(within(panel).getByText("Ada Lovelace")).toBeVisible(),
    );
    // The API filters by the role's identifier, not its display name.
    expect(roleFilter).toBe("reviewer");
    // Both sections share the page: usage first, then the permissions.
    const usage = screen.getByRole("heading", { name: "Usage" });
    const permissions = screen.getByRole("heading", { name: "Permissions" });
    expect(
      usage.compareDocumentPosition(permissions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Agents" })).toBeVisible();
  });

  it("keeps the permissions readable for a viewer who may not list people", async () => {
    // Only the people lists need their own read permissions; the role page
    // itself does not, so it must not ask for them on the viewer's behalf.
    vi.mocked(useHasPermissions).mockImplementation(((permissions: object) => ({
      data: !(
        "team" in permissions ||
        "member" in permissions ||
        "serviceAccount" in permissions
      ),
    })) as never);
    const asked: string[] = [];
    server.events.on("request:start", ({ request }) => {
      asked.push(new URL(request.url).pathname);
    });

    renderPage("role-1");

    expect(
      await screen.findByText(
        "You don't have permission to see who holds this role.",
      ),
    ).toBeVisible();
    expect(await screen.findByRole("region", { name: "Agents" })).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(asked).not.toContain("/api/teams");
    expect(asked).not.toContain("/api/members");
    expect(asked).not.toContain("/api/service-accounts");
  });
});
