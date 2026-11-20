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
  expect,
  test,
  vi,
} from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => () => undefined,
  useSetSettingsPageHeader: () => () => undefined,
}));

import { useRouter } from "next/navigation";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { OAuthClientCreatePage } from "./oauth-client-create-page";

const origin = "http://localhost:9000";
const created: unknown[] = [];
const empty = {
  data: [],
  pagination: { limit: 1000, hasNext: false, nextCursor: null },
};
const server = setupServer(
  http.post(`${origin}/api/oauth-clients`, async ({ request }) => {
    created.push(await request.json());
    return HttpResponse.json({
      id: "client-1",
      clientId: "oauth_example",
      clientSecret: "oauth_secret_example",
      scopes: ["mcp", "a2a"],
    });
  }),
  http.get(`${origin}/api/llm-provider-api-keys`, () => HttpResponse.json([])),
  http.get(`${origin}/api/agents/options`, () => HttpResponse.json(empty)),
  http.get(`${origin}/api/oauth-clients/labels/keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${origin}/api/teams`, () =>
    HttpResponse.json({
      data: [],
      pagination: {
        currentPage: 1,
        limit: 100,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    }),
  ),
  http.get(`${origin}/api/limits`, () => HttpResponse.json([])),
);

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
  created.length = 0;
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
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

test("moving between steps never creates the client; only Create does", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OAuthClientCreatePage />
    </QueryClientProvider>,
  );

  await user.type(screen.getByRole("textbox", { name: "Name" }), "Web app");
  await user.click(screen.getByRole("radio", { name: /For its users/ }));
  await user.click(screen.getByRole("button", { name: "Access" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Redirect URIs" }),
    "https://app.example.com/callback",
  );

  // Back and forward again with every field filled: the Access click must
  // not land on the Create button that takes its place.
  await user.click(screen.getByRole("button", { name: "Details" }));
  await user.click(screen.getByRole("button", { name: "Access" }));
  expect(
    await screen.findByRole("button", { name: "Create OAuth client" }),
  ).toBeEnabled();
  expect(created).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "Create OAuth client" }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]).toMatchObject({
    name: "Web app",
    grantType: "authorization_code",
    redirectUris: ["https://app.example.com/callback"],
  });
  expect(
    await screen.findByRole("dialog", { name: "OAuth Client Created" }),
  ).toBeVisible();
});
