import { archestraApiClient } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { useAllPermissions } from "@/lib/auth/auth.query";
import { RoleCreatePage } from "./role-create-page.ee";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsPageHeader: () => vi.fn(),
  useSetSettingsAction: () => vi.fn(),
}));

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

const roles = [
  {
    id: "member",
    name: "member",
    role: "member",
    description: null,
    predefined: true,
    permission: { chat: ["read", "create"] },
  },
  {
    id: "role-1",
    name: "Reviewer",
    role: "reviewer",
    description: "Reads everything, changes nothing.",
    predefined: false,
    permission: { agent: ["read"], skill: ["read"] },
  },
];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  vi.mocked(useAllPermissions).mockReturnValue({
    data: predefinedPermissionsMap.admin,
  } as never);
  server.use(
    http.get(`${API_ORIGIN}/api/roles`, () =>
      HttpResponse.json({
        data: roles,
        pagination: {
          currentPage: 1,
          limit: 100,
          total: roles.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RoleCreatePage />, { wrapper });
}

describe("RoleCreatePage", () => {
  it("starts from a copied role and creates with the edited permissions", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    let body: unknown;
    server.use(
      http.post(`${API_ORIGIN}/api/roles`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...roles[1], id: "role-2", name: "QA" });
      }),
    );
    renderPage();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "QA" },
    });
    const howToStart = await screen.findByRole("radiogroup", {
      name: "How to start",
    });
    // Copying is offered once the organization's custom roles have loaded.
    const copy = within(howToStart).getByRole("radio", {
      name: /Copy a custom role/,
    });
    await waitFor(() => expect(copy).toBeEnabled());
    fireEvent.click(copy);
    const customRoles = screen.getByRole("radiogroup", {
      name: "Custom roles",
    });
    fireEvent.click(
      within(customRoles).getByRole("radio", { name: /Reviewer/ }),
    );
    expect(
      within(customRoles).getByRole("radio", { name: /Reviewer/ }),
    ).toBeChecked();
    expect(screen.getByText(/starts with 2 of \d+ permissions/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    const agents = await screen.findByRole("region", { name: "Agents" });
    expect(
      within(agents).getByRole("checkbox", { name: "View agents" }),
    ).toBeChecked();
    fireEvent.click(
      within(agents).getByRole("checkbox", { name: "Create agents" }),
    );
    expect(screen.getByText("3 permissions selected")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    await waitFor(() =>
      expect(body).toEqual({
        name: "QA",
        permission: { agent: ["read", "create"], skill: ["read"] },
      }),
    );
    expect(push).toHaveBeenCalledWith("/settings/roles/role-2");
  });

  it("will not create a role without a name or without any permission", async () => {
    renderPage();
    await screen.findByRole("radiogroup", { name: "How to start" });
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    // The name is checked before the step changes.
    expect(await screen.findByText("Name is required")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "QA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    await screen.findByRole("region", { name: "Agents" });
    expect(screen.getByRole("button", { name: "Create role" })).toBeDisabled();
  });

  it("opens on the preset a deep link names", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("from=member") as never,
    );
    renderPage();
    const presets = await screen.findByRole("radiogroup", {
      name: "Preset roles",
    });
    expect(
      within(presets).getByRole("radio", { name: /Member/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /Start from a preset/ }),
    ).toBeChecked();
  });

  it("starts blank until a custom role is picked, and offers no copy without any", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/roles`, () =>
        HttpResponse.json({
          data: [roles[0]],
          pagination: {
            currentPage: 1,
            limit: 100,
            total: 1,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          },
        }),
      ),
    );
    renderPage();
    const howToStart = await screen.findByRole("radiogroup", {
      name: "How to start",
    });
    expect(
      within(howToStart).getByRole("radio", { name: /Start blank/ }),
    ).toBeChecked();
    await screen.findByRole("radio", { name: /Start from a preset/ });
    expect(
      within(howToStart).getByRole("radio", {
        name: /Copy a custom role.*No custom roles yet/,
      }),
    ).toBeDisabled();
    expect(screen.getByText("0 permissions selected")).toBeVisible();
  });

  it("keeps the chosen custom role in view while a search filters the rest", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `custom-${index}`,
      name: `Custom ${index}`,
      role: `custom_${index}`,
      description: "",
      predefined: false,
      permission: { chat: ["read"] },
    }));
    server.use(
      http.get(`${API_ORIGIN}/api/roles`, () =>
        HttpResponse.json({
          data: [...many, roles[0]],
          pagination: {
            currentPage: 1,
            limit: 100,
            total: 10,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          },
        }),
      ),
    );
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("from=custom-7") as never,
    );
    renderPage();
    const customRoles = await screen.findByRole("radiogroup", {
      name: "Custom roles",
    });
    expect(
      within(customRoles).getByRole("radio", { name: /Custom 7/ }),
    ).toBeChecked();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search custom roles" }),
      { target: { value: "Custom 2" } },
    );
    expect(
      within(customRoles).getByRole("radio", { name: /Custom 2/ }),
    ).toBeVisible();
    expect(
      within(customRoles).queryByRole("radio", { name: /Custom 3/ }),
    ).toBeNull();
    // Still listed, though it no longer matches: the selection never hides.
    expect(
      within(customRoles).getByRole("radio", { name: /Custom 7/ }),
    ).toBeChecked();
  });
});
