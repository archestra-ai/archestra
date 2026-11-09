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
import type {
  AutoRouter,
  AutoRouterCreate,
  AutoRoutingState,
} from "@/lib/auto-routing.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { ConfigureAutoRoutingDialog } from "./configure-dialog";

vi.mock("sonner");
vi.mock("@/lib/organization.query");

// Radix Select and Popover need pointer capture and scrolling, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const KEY = { id: "00000000-0000-4000-8000-000000000501", name: "Org key" };
const ROUTER_ID = "00000000-0000-4000-8000-0000000000a1";
const MODELS = {
  fast: "claude-haiku",
  normal: "claude-sonnet",
  smart: "claude-opus",
};
const dbId = (modelId: string) => `db-${modelId}`;

const state: AutoRoutingState = {
  enabled: true,
  eligibleApiKeyIds: [KEY.id],
  decisionProviders: [
    {
      provider: "jev",
      models: [{ id: "jev-1.13.0", displayName: "Jev 1.13" }],
      apiKeys: [],
    },
  ],
};

const tier = (modelId: string) => ({
  id: dbId(modelId),
  provider: "anthropic" as const,
  modelId,
  apiKey: KEY,
});

const autoRouter: AutoRouter = {
  id: ROUTER_ID,
  name: "auto",
  enabled: true,
  budgetUsdPerDay: null,
  budgetPreset: "balanced",
  tiers: {
    fast: tier(MODELS.fast),
    normal: tier(MODELS.normal),
    smart: tier(MODELS.smart),
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
      sessions: 0,
      required: 100,
    },
    lastFitError: null,
    scorer: "ready",
    scorerApiKey: null,
  },
};

const created: AutoRouterCreate[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/state`, () =>
    HttpResponse.json(state),
  ),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([{ ...KEY, provider: "anthropic", scope: "org" }]),
  ),
  http.get(`${API_ORIGIN}/api/llm-models`, () =>
    HttpResponse.json(
      Object.values(MODELS).map((modelId) => ({
        id: dbId(modelId),
        provider: "anthropic",
        modelId,
        description: modelId,
        ignored: false,
        embeddingDimensions: null,
        apiKeys: [{ ...KEY, provider: "anthropic", scope: "org" }],
      })),
    ),
  ),
  http.post(`${API_ORIGIN}/api/auto-routing/routers`, async ({ request }) => {
    created.push((await request.json()) as AutoRouterCreate);
    return HttpResponse.json({ ...autoRouter, fit: null });
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
  created.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderDialog(
  router: AutoRouter | null,
  existingNames: string[],
  onOpenChange = vi.fn(),
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConfigureAutoRoutingDialog
        router={router}
        existingNames={existingNames}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

async function chooseTier(
  user: ReturnType<typeof userEvent.setup>,
  label: "Fast" | "Normal" | "Smart",
  modelId: string,
) {
  await user.click(
    await screen.findByRole("button", { name: `${label} provider key` }),
  );
  await user.click(await screen.findByRole("option", { name: /Org key/ }));
  // The model select opens once its key is set.
  const row = screen
    .getByRole("button", {
      name: `${label} provider key`,
    })
    .closest("li");
  if (!row) throw new Error(`${label} row missing`);
  await user.click(within(row).getByRole("combobox"));
  await user.click(
    await screen.findByRole("option", { name: new RegExp(modelId) }),
  );
}

describe("ConfigureAutoRoutingDialog", () => {
  it("creates a router with its name, tiers, budget preset and decision model", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog(null, ["auto"]);

    await user.type(await screen.findByLabelText("Name"), "support");
    await chooseTier(user, "Fast", MODELS.fast);
    await chooseTier(user, "Normal", MODELS.normal);
    await chooseTier(user, "Smart", MODELS.smart);
    await user.click(screen.getByRole("radio", { name: /Intelligence/ }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(created).toEqual([
        {
          name: "auto:support",
          budgetPreset: "intelligence",
          tiers: {
            fast: { providerApiKeyId: KEY.id, modelId: dbId(MODELS.fast) },
            normal: { providerApiKeyId: KEY.id, modelId: dbId(MODELS.normal) },
            smart: { providerApiKeyId: KEY.id, modelId: dbId(MODELS.smart) },
          },
          decisionModel: { apiKeyId: null, model: "jev-1.13.0" },
        },
      ]),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("lets the router named auto be renamed like any other", async () => {
    renderDialog(autoRouter, ["auto"]);

    const name = await screen.findByLabelText("Name");

    expect(name).toHaveValue("");
    expect(name).toBeEnabled();
    expect(
      screen.getByText(/Leave the name empty to call the router auto/),
    ).toBeInTheDocument();
  });

  it("blocks a name another router already has", async () => {
    const user = userEvent.setup();
    renderDialog(null, ["auto", "auto:support"]);

    await user.type(await screen.findByLabelText("Name"), "support");

    expect(
      await screen.findByText("Another router is already named auto:support."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(created).toEqual([]);
  });
});
