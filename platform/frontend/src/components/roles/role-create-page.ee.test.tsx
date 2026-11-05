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
    const startFrom = await screen.findByRole("radiogroup", {
      name: "Start from",
    });
    fireEvent.click(
      await within(startFrom).findByRole("radio", { name: /Reviewer/ }),
    );
    expect(
      within(startFrom).getByRole("radio", { name: /Reviewer.*2 permissions/ }),
    ).toBeChecked();

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
    await screen.findByRole("radiogroup", { name: "Start from" });
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

  it("preselects the role a deep link names", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("from=member") as never,
    );
    renderPage();
    const startFrom = await screen.findByRole("radiogroup", {
      name: "Start from",
    });
    await waitFor(() =>
      expect(
        within(startFrom).getByRole("radio", { name: /member/i }),
      ).toBeChecked(),
    );
  });

  it("keeps the first roles in view and reveals the rest on request", async () => {
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
    renderPage();
    const startFrom = await screen.findByRole("radiogroup", {
      name: "Start from",
    });
    // Built-in first, then three custom ones: Blank plus four fill the first
    // five boxes, and the sixth counts the rest.
    await within(startFrom).findByRole("radio", { name: /member/i });
    expect(within(startFrom).getAllByRole("radio")).toHaveLength(5);
    expect(
      within(startFrom).queryByRole("radio", { name: /Custom 7/ }),
    ).toBeNull();
    fireEvent.click(
      within(startFrom).getByRole("button", { name: /6 more roles/ }),
    );
    expect(within(startFrom).getAllByRole("radio")).toHaveLength(11);
    expect(
      within(startFrom).getByRole("radio", { name: /Custom 7/ }),
    ).toBeVisible();
  });
});
