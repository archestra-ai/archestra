import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter, useSearchParams } from "next/navigation";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { AutoRouter, AutoRoutingState } from "@/lib/auto-routing.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import AutoRoutersPage from "./page";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

// Radix needs pointer capture and scrolling, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const KEY = { id: "00000000-0000-4000-8000-000000000501", name: "Org key" };
const tier = (modelId: string, index: number) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  provider: "anthropic" as const,
  modelId,
  apiKey: KEY,
});

function makeRouter(overrides: Partial<AutoRouter>): AutoRouter {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "auto",
    enabled: true,
    budgetUsdPerDay: null,
    budgetPreset: "balanced",
    tiers: {
      fast: tier("claude-haiku", 1),
      normal: tier("claude-sonnet", 2),
      smart: tier("claude-opus", 3),
    },
    decisionModel: { apiKeyId: null, model: "jev-1.13.0" },
    usesPastSessions: true,
    virtualApiKeyIds: [],
    usage: { agentCount: 0, organizationDefault: false },
    generation: 1,
    plannedGeneration: 1,
    status: {
      activePlan: null,
      coldStart: {
        scorerVersionId: "00000000-0000-4000-8000-000000000009",
        sessions: 12,
        required: 100,
      },
      lastFitError: null,
      scorer: "ready",
      scorerApiKey: null,
    },
    ...overrides,
  };
}

const auto = makeRouter({});
const support = makeRouter({
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "auto:support",
  budgetPreset: null,
  budgetUsdPerDay: 12,
  virtualApiKeyIds: ["key-1"],
});

const state: AutoRoutingState = {
  enabled: true,
  eligibleApiKeyIds: [KEY.id],
  decisionProviders: [],
};

const deleted: string[] = [];
const push = vi.fn();

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
    HttpResponse.json([auto, support]),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/state`, () =>
    HttpResponse.json(state),
  ),
  http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([]),
  ),
  http.delete(`${API_ORIGIN}/api/auto-routing/routers/:id`, ({ params }) => {
    deleted.push(String(params.id));
    return HttpResponse.json({ success: true });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.clearAllMocks();
  deleted.length = 0;
  vi.mocked(useRouter).mockReturnValue({
    push,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AutoRoutersPage />
    </QueryClientProvider>,
  );
}

describe("AutoRoutersPage", () => {
  it("lists the routers by name", async () => {
    renderPage();

    expect(await screen.findByText("auto:support")).toBeInTheDocument();
    expect(screen.getByText("auto")).toBeInTheDocument();
    expect(screen.getByText("$12.00/day")).toBeInTheDocument();
    expect(screen.getByText("1 virtual key")).toBeInTheDocument();
  });

  it("opens a router's page when its row is clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText("auto:support"));

    expect(push).toHaveBeenCalledWith(`/llm/auto-routing/${support.id}`);
  });

  it("opens the dialog that creates a router", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("auto:support");

    await user.click(
      screen.getByRole("button", { name: /Create auto router/ }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Create auto router",
    );
  });

  it("deletes the router the admin confirms", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("auto:support");

    await user.click(
      screen.getByRole("button", { name: /More actions.*auto:support/ }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Delete "auto:support"?');
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toEqual([support.id]));
  });
});
