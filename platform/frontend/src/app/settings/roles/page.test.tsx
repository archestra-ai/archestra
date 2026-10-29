"use client";

import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import { useSession } from "@/lib/auth/auth.query";
import {
  useEnterpriseFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
import RolesSettingsPage from "./page";

const mockImpersonate = vi.fn();

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/components/roles/roles-list.ee", () => ({
  // The real list renders headerAction opposite its search field; the stub has
  // to render it too or the debugger trigger disappears from the page.
  RolesList: ({ headerAction }: { headerAction?: React.ReactNode }) => (
    <div>
      roles list
      {headerAction}
    </div>
  ),
}));

vi.mock("@/lib/impersonation.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonation.query")>()),
  useCanImpersonate: () => true,
  useImpersonateUser: () => ({ mutate: mockImpersonate, isPending: false }),
}));

const API_ORIGIN = "http://localhost:9000";
const IMPERSONABLE_URL = `${API_ORIGIN}/api/user/impersonable`;
const server = setupServer();
const searches: string[] = [];

// 45 candidates: more than two pages of 20, so the last ones are only
// reachable by paging or by server search.
const CANDIDATES = Array.from({ length: 45 }, (_, index) => ({
  id: `user-${index}`,
  name: `Person ${String(index).padStart(2, "0")}`,
  email: `person-${index}@example.com`,
  role: index === 0 ? null : "member",
}));

function serveCandidates(candidates: typeof CANDIDATES) {
  server.use(
    http.get(IMPERSONABLE_URL, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const search = params.get("search") ?? "";
      searches.push(search);
      const offset = Number(params.get("cursor") ?? 0);
      const limit = Number(params.get("limit"));
      const filtered = candidates.filter((row) => row.name.includes(search));
      const hasNext = offset + limit < filtered.length;
      return HttpResponse.json({
        data: filtered.slice(offset, offset + limit),
        pagination: {
          limit,
          hasNext,
          nextCursor: hasNext ? String(offset + limit) : null,
        },
      });
    }),
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RolesSettingsPage />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  searches.length = 0;
  mockImpersonate.mockReset();
  // The trigger sits inside the roles list, which DisabledEnterpriseSection
  // renders pointer-events-none without a licence.
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  vi.mocked(useSmallTeamTier).mockReturnValue(
    undefined as ReturnType<typeof useSmallTeamTier>,
  );
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "admin" } },
  } as ReturnType<typeof useSession>);
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("RolesSettingsPage role debugger", () => {
  it("searches the server and views the app as a user beyond the first page", async () => {
    serveCandidates(CANDIDATES);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: /debug a role/i }),
    );
    await user.click(screen.getByRole("combobox", { name: "Select a user" }));
    expect(
      await screen.findByRole("option", { name: /Person 01 · Member/ }),
    ).toBeInTheDocument();
    // A candidate without a role keeps the plain name.
    expect(
      screen.getByRole("option", { name: /Person 00/ }),
    ).not.toHaveTextContent("·");
    expect(
      screen.queryByRole("option", { name: /Person 44/ }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search users"), "Person 44");
    await user.click(
      await screen.findByRole("option", { name: /Person 44 · Member/ }),
    );
    expect(searches).toContain("Person 44");
    expect(
      screen.getByRole("combobox", { name: "Select a user" }),
    ).toHaveTextContent("Person 44 · Member");

    await user.click(screen.getByRole("button", { name: /view as user/i }));
    expect(mockImpersonate).toHaveBeenCalledWith("user-44");
  });

  it("hides the debugger when the org has nobody to impersonate", async () => {
    serveCandidates([]);
    renderPage();

    expect(await screen.findByText("roles list")).toBeInTheDocument();
    await waitFor(() => expect(searches).toEqual([""]));
    expect(
      screen.queryByRole("button", { name: /debug a role/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the debugger visible with a retry when the candidate fetch fails", async () => {
    // Hiding on error would make an outage look like a single-user org.
    server.use(
      http.get(IMPERSONABLE_URL, () =>
        HttpResponse.json(
          { error: { message: "boom", type: "api_internal_server_error" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: /debug a role/i }),
    );
    expect(
      await screen.findByText("Couldn't load users to impersonate"),
    ).toBeInTheDocument();

    serveCandidates(CANDIDATES);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await user.click(
      await screen.findByRole("combobox", { name: "Select a user" }),
    );
    expect(
      await screen.findByRole("option", { name: /Person 01 · Member/ }),
    ).toBeInTheDocument();
  });
});
