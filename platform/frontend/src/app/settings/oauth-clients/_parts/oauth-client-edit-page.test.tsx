import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
let header: { backLink?: ReactNode } | null = null;
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => () => undefined,
  useSetSettingsPageHeader: () => (next: { backLink?: ReactNode } | null) => {
    if (next) header = next;
  },
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { OAuthClientEditPage } from "./oauth-client-edit-page";

const origin = "http://localhost:9000";
const client = {
  id: "client-1",
  clientId: "oauth_example",
  serviceAccountId: null,
  name: "Evals bot",
  organizationId: "org-1",
  grantType: "client_credentials",
  scopes: ["llm:proxy"],
  allowedGatewayIds: [],
  providerApiKeys: [
    {
      provider: "openai",
      providerApiKeyId: "key-1",
      providerApiKeyName: "Main OpenAI",
    },
  ],
  includeFutureProviders: false,
  modelPoolIds: [],
  autoRouterIds: [],
  redirectUris: [],
  disabled: false,
  authorId: null,
  authorName: null,
  labels: [],
  createdBy: null,
  billingTeam: { id: "team-1", name: "Platform" },
  spendCap: {
    limitId: "cap-1",
    limitValue: 200,
    cleanupInterval: "calendar_month",
    currentUsage: 34,
    estimatedUsage: false,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const updates: unknown[] = [];
const server = setupServer(
  http.get(`${origin}/api/oauth-clients/client-1`, () =>
    HttpResponse.json(client),
  ),
  http.put(`${origin}/api/oauth-clients/client-1`, async ({ request }) => {
    updates.push(await request.json());
    return HttpResponse.json({ ...client, ...(updates.at(-1) as object) });
  }),
  http.get(`${origin}/api/llm-provider-api-keys`, () => HttpResponse.json([])),
  http.get(`${origin}/api/teams`, () =>
    HttpResponse.json({
      data: [{ id: "team-1", name: "Platform", memberCount: 0 }],
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
  http.get(`${origin}/api/limits`, () => HttpResponse.json([])),
  http.get(`${origin}/api/model-pools`, () => HttpResponse.json([])),
  http.get(`${origin}/api/oauth-clients/labels/keys`, () =>
    HttpResponse.json([]),
  ),
);

const push = vi.fn();
let searchParams = new URLSearchParams();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.clearAllMocks();
  header = null;
  updates.length = 0;
  searchParams = new URLSearchParams();
  vi.mocked(useSearchParams).mockImplementation(
    () => searchParams as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(usePathname).mockReturnValue("/settings/oauth-clients/client-1");
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useScopedCapabilities>);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
});

test.each([
  {
    from: "the client's page",
    query: "",
    href: "/settings/oauth-clients/client-1",
  },
  { from: "the list", query: "from=list", href: "/settings/oauth-clients" },
])("opened from $from, back and Save return there", async ({ query, href }) => {
  searchParams = new URLSearchParams(query);
  const user = userEvent.setup();
  renderPage();

  const name = await screen.findByRole("textbox", { name: "Name" });
  // The client's budget is loaded into the form.
  expect(
    screen.getByRole("textbox", { name: "Spend cap in dollars" }),
  ).toHaveValue("200");
  await waitFor(() => expect(header?.backLink).toBeTruthy());
  render(<>{header?.backLink}</>);
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: /^Back to OAuth client/ }),
    ).toHaveAttribute("href", href),
  );

  await user.clear(name);
  await user.type(name, "Evals bot (prod)");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(push).toHaveBeenCalledWith(href));
  // Only what changed, and nothing that needs its own permission.
  expect(updates.at(-1)).toMatchObject({ name: "Evals bot (prod)" });
  expect(updates.at(-1)).not.toHaveProperty("spendCap");
  expect(updates.at(-1)).not.toHaveProperty("billingTeamId");
});

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OAuthClientEditPage oauthClientId="client-1" />
    </QueryClientProvider>,
  );
}
