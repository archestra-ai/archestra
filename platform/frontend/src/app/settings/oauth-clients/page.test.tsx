import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

import { useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
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
});
