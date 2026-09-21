import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { ResourceScopeFilter } from "./resource-scope-filter";

vi.mock("next/navigation");
vi.mock("@/lib/clients/auth/auth-client");

const origin = "http://localhost:9000";
const server = setupServer(
  http.get(`${origin}/api/user/permissions`, () =>
    HttpResponse.json({ team: ["read"], agent: ["read"] }),
  ),
  http.get(`${origin}/api/teams`, () =>
    HttpResponse.json({
      data: [
        { id: "team-alpha", name: "Alpha Research" },
        { id: "team-beta", name: "Beta Engineering" },
      ],
    }),
  ),
);
let client: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: { user: { id: "test-user" }, session: { id: "test-session" } },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.mocked(usePathname).mockReturnValue("/agents");
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});
afterEach(() => {
  cleanup();
  client.clear();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("searches teams, selects with the keyboard, and clears the URL filter when the last team is removed", async () => {
  const user = userEvent.setup();
  const tree = (
    <QueryClientProvider client={client}>
      <ResourceScopeFilter
        ownerLabelPlural="agents"
        adminPermission={{ agent: ["admin"] }}
      />
    </QueryClientProvider>
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("scope=team&page=3&name=demo") as ReturnType<
      typeof useSearchParams
    >,
  );
  const { rerender } = render(tree);
  const trigger = await screen.findByRole("combobox", {
    name: "Filter by teams",
  });
  expect(trigger).toHaveTextContent("All teams");
  await user.click(trigger);
  await user.keyboard("research alpha{ArrowDown}{Enter}");
  expect(useRouter().push).toHaveBeenLastCalledWith(
    "/agents?scope=team&name=demo&teamIds=team-alpha",
    { scroll: false },
  );
  expect(screen.getByPlaceholderText("Search...")).toHaveFocus();

  // Apply the navigation result as the Next.js router would after the URL changes.
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "scope=team&name=demo&teamIds=team-alpha",
    ) as ReturnType<typeof useSearchParams>,
  );
  rerender(
    <QueryClientProvider client={client}>
      <ResourceScopeFilter
        ownerLabelPlural="agents"
        adminPermission={{ agent: ["admin"] }}
      />
    </QueryClientProvider>,
  );
  expect(trigger).toHaveTextContent("1 team selected");
  expect(
    screen.getByRole("option", { name: "Alpha Research" }),
  ).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  expect(useRouter().push).toHaveBeenLastCalledWith(
    "/agents?scope=team&name=demo",
    { scroll: false },
  );
});
