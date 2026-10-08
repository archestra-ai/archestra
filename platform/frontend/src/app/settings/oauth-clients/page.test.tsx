import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const API_ORIGIN = "http://localhost:9000";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: vi.fn(() => () => undefined),
}));

import { useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import OauthClientsPage from "./page";

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-oauth-clients`, ({ request }) => {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    if (limit > 100) {
      return HttpResponse.json(
        { error: { message: "Limit exceeds maximum", type: "validation" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      data: [],
      pagination: {
        currentPage: 1,
        limit,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }),
  http.get(`${API_ORIGIN}/api/mcp-oauth-clients`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/agents/all`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([]),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("OauthClientsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [
        { resource: "llmOauthClient", scope: "*", action: "read" },
        { resource: "mcpOauthClient", scope: "*", action: "read" },
      ],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
  });

  it("loads the unified list within the API pagination limit", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OauthClientsPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "No OAuth clients yet. Register one for an application that authenticates with OAuth.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Couldn't load OAuth clients"),
    ).not.toBeInTheDocument();
  });

  it("shows who pays for an LLM client and opens a client from its row", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-oauth-clients`, () =>
        HttpResponse.json({
          data: [
            {
              id: "llm-row-1",
              clientId: "llm_oauth_ci",
              name: "ci-runner",
              organizationId: "org-1",
              grantType: "client_credentials",
              providerApiKeys: [],
              redirectUris: [],
              disabled: false,
              authorId: "user-1",
              authorName: "Ada",
              createdBy: null,
              labels: [],
              billingTeam: { id: "team-1", name: "Data Science" },
              spendCap: {
                limitId: "limit-1",
                limitValue: 200,
                cleanupInterval: "calendar_month",
                currentUsage: 34,
              },
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
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
      http.get(`${API_ORIGIN}/api/mcp-oauth-clients`, () =>
        HttpResponse.json([
          {
            id: "mcp-row-1",
            clientId: "mcp_oauth_portal",
            name: "internal-portal",
            organizationId: "org-1",
            grantType: "authorization_code",
            allowedGatewayIds: [],
            redirectUris: ["https://portal.example.com/cb"],
            disabled: false,
            authorId: "user-1",
            authorName: "Ada",
            createdBy: null,
            labels: [],
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
      ),
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OauthClientsPage />
      </QueryClientProvider>,
    );

    const llmRow = (await screen.findByText("ci-runner")).closest("tr");
    if (!llmRow) throw new Error("Missing LLM client row");
    expect(within(llmRow).getByText("As itself")).toBeVisible();
    expect(within(llmRow).getByText("Data Science")).toBeVisible();
    expect(within(llmRow).getByText("$200/month cap")).toBeVisible();

    const mcpRow = screen.getByText("internal-portal").closest("tr");
    if (!mcpRow) throw new Error("Missing MCP client row");
    expect(within(mcpRow).getByText("For its users")).toBeVisible();
    expect(within(mcpRow).getByText("What each user can reach")).toBeVisible();
    await user.click(within(mcpRow).getByText("For its users"));

    expect(
      await screen.findByRole("dialog", { name: /internal-portal/ }),
    ).toBeVisible();
  });

  it("keeps a client's permissions in its edit dialog, not its row actions", async () => {
    const requested: string[] = [];
    server.use(
      http.get(`${API_ORIGIN}/api/mcp-oauth-clients`, () =>
        HttpResponse.json([
          {
            id: "client-row-1",
            clientId: "client-1",
            name: "Deploy bot",
            organizationId: "org-1",
            grantType: "client_credentials",
            allowedGatewayIds: [],
            redirectUris: [],
            disabled: false,
            authorId: "user-1",
            authorName: "Ada",
            createdBy: null,
            labels: [],
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
      ),
      http.get(
        `${API_ORIGIN}/api/resource-permissions/:resource/:scope`,
        ({ params }) => {
          requested.push(`${params.resource}/${params.scope}`);
          return HttpResponse.json({
            resource: params.resource,
            scope: params.scope,
            name: "Deploy bot",
            revision: 1,
            grants: [],
            inheritedGrants: [],
            effectiveActions: ["read", "manage-permissions"],
          });
        },
      ),
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OauthClientsPage />
      </QueryClientProvider>,
    );

    const row = (await screen.findByText("Deploy bot")).closest("tr");
    if (!row) throw new Error("Missing client row");
    expect(
      within(row).queryByRole("button", { name: /Permissions/ }),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Edit/ }));

    expect(
      await screen.findByRole("dialog", { name: /Deploy bot/ }),
    ).toBeVisible();
    await waitFor(() =>
      expect(requested).toContain("mcpOauthClient/client-row-1"),
    );
  });

  it("offers the permissions of both client kinds from the header menu", async () => {
    let headerAction: React.ReactNode = null;
    const { useSetSettingsAction } = await import("@/app/settings/layout");
    vi.mocked(useSetSettingsAction).mockReturnValue((node) => {
      headerAction = node;
    });
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OauthClientsPage />
      </QueryClientProvider>,
    );
    render(
      <QueryClientProvider client={queryClient}>
        {headerAction}
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(
      screen.getByRole("menuitem", { name: "LLM client permissions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "MCP client permissions" }),
    ).toBeVisible();
  });
});
