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

const page = (data: unknown[], limit = 20, total = data.length) => ({
  data,
  pagination: {
    currentPage: 1,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: total > limit,
    hasPrev: false,
  },
});
const client = {
  id: "client-1",
  clientId: "oauth_example",
  name: "Combined bot",
  organizationId: "org-1",
  grantType: "client_credentials",
  scopes: ["mcp", "a2a", "llm:proxy"],
  allowedGatewayIds: ["agent-1"],
  providerApiKeys: [
    {
      provider: "openai",
      providerApiKeyId: "key-1",
      providerApiKeyName: "Main OpenAI",
    },
  ],
  includeFutureProviders: false,
  redirectUris: [],
  disabled: false,
  labels: [],
  createdBy: null,
  billingTeam: { id: "team-1", name: "Platform" },
  spendCap: {
    limitId: "cap-1",
    limitValue: 200,
    cleanupInterval: "calendar_month",
    currentUsage: 34,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
};
const requested: string[] = [];
const server = setupServer(
  http.get(`${API_ORIGIN}/api/oauth-clients`, () =>
    HttpResponse.json(page([])),
  ),
  http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
    expect(new URL(request.url).searchParams.get("ids")).toBe("agent-1");
    return HttpResponse.json({
      data: [{ id: "agent-1", name: "Support agent", agentType: "agent" }],
      pagination: { limit: 1000, hasNext: false, nextCursor: null },
    });
  }),
  http.get(`${API_ORIGIN}/api/oauth-clients/labels/keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${API_ORIGIN}/api/teams`, () =>
    HttpResponse.json(
      page([
        { id: "team-1", name: "Platform", description: null, memberCount: 0 },
      ]),
    ),
  ),
  http.get(`${API_ORIGIN}/api/limits`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(
    `${API_ORIGIN}/api/resource-permissions/:resource/:scope`,
    ({ params }) => {
      requested.push(`${params.resource}/${params.scope}`);
      return HttpResponse.json({
        resource: params.resource,
        scope: params.scope,
        name: "Combined bot",
        revision: 1,
        grants: [],
        inheritedGrants: [],
        actorSubjects: [],
        effectiveActions: ["read", "update", "manage-permissions"],
      });
    },
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
        { resource: "oauthClient", scope: "*", action: "read" },
        { resource: "oauthClient", scope: "*", action: "read" },
      ],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
  });

  it("loads one paginated endpoint and removes the Types filter", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${API_ORIGIN}/api/oauth-clients`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(page([]));
      }),
    );
    renderPage();
    expect(
      await screen.findByText(
        "No OAuth clients yet. Register one for an application that authenticates with OAuth.",
      ),
    ).toBeVisible();
    expect(Number(query?.get("limit"))).toBeLessThanOrEqual(100);
    expect(screen.queryByText("Types")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load OAuth clients"),
    ).not.toBeInTheDocument();
  });

  it("shows all enabled capabilities and opens the combined edit flow", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/oauth-clients`, () =>
        HttpResponse.json(page([client])),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("Combined bot")).closest("tr");
    if (!row) throw new Error("Missing row");
    for (const label of [
      "MCP Gateway",
      "A2A",
      "LLM Proxy",
      "1 target",
      "1 agent",
      "1 key",
      "Main OpenAI",
    ])
      expect(await within(row).findByText(label)).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "Budget" }),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByText("Combined bot"));
    expect(
      await screen.findByRole("dialog", { name: /Combined bot/ }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Budget" }));
    expect(
      screen.getByRole("textbox", { name: "Spend cap in dollars" }),
    ).toHaveValue("200");
    expect(
      await screen.findByRole("combobox", {
        name: "Who pays for this client?",
      }),
    ).toHaveTextContent("Platform");
    await user.click(screen.getByRole("button", { name: "Access" }));
    for (const label of [/MCP Gateway/, /A2A/, /LLM Proxy/])
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    await waitFor(() => expect(requested).toContain("oauthClient/client-1"));
  });

  it("loads a capability filter from the URL and keeps combined clients visible", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("capability=mcp") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    let capability: string | null = null;
    server.use(
      http.get(`${API_ORIGIN}/api/oauth-clients`, ({ request }) => {
        capability = new URL(request.url).searchParams.get("capability");
        return HttpResponse.json(page([client]));
      }),
    );
    renderPage();
    expect(await screen.findByText("Combined bot")).toBeVisible();
    expect(capability).toBe("mcp");
    expect(
      screen.getByRole("combobox", { name: "Filter by API access" }),
    ).toHaveTextContent("MCP Gateway");
  });

  it("offers a single canonical permissions control", async () => {
    let headerAction: React.ReactNode = null;
    const { useSetSettingsAction } = await import("@/app/settings/layout");
    vi.mocked(useSetSettingsAction).mockReturnValue((node) => {
      headerAction = node;
    });
    renderPage();
    await screen.findByText(
      "No OAuth clients yet. Register one for an application that authenticates with OAuth.",
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        {headerAction}
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(
      screen.queryByRole("button", { name: "LLM client permissions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(
      await screen.findByRole("dialog", { name: /Permissions for all/ }),
    ).toBeVisible();
  });
});
function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OauthClientsPage />
    </QueryClientProvider>,
  );
}
