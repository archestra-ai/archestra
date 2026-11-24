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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useEnterpriseFeature,
  useFeature,
  useProviderBaseUrls,
} from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import LlmProxyPage from "./page";

// Keep a missing MSW handler away from the developer's running backend.
const API_ORIGIN = "http://127.0.0.1:1";

// Radix Select and DropdownMenu need pointer capture and scrollIntoView,
// which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));

const ANTHROPIC_KEY = {
  id: "pk-anthropic",
  name: "Team",
  provider: "anthropic",
  scope: "org",
  requiresReauthentication: false,
};
const JEV_KEY = {
  id: "pk-jev",
  name: "TypeSafe",
  provider: "jev",
  scope: "org",
  requiresReauthentication: true,
};
const JUDGE_KEY = {
  id: "vk-judge",
  name: "Judge pipeline",
  keyType: "standard",
  tokenStart: "arch_ab",
  authorId: "user-1",
  providerApiKeys: [
    {
      provider: "jev",
      providerApiKeyId: "pk-jev",
      providerApiKeyName: "TypeSafe",
    },
  ],
};
const POOL = {
  id: "pool-1",
  name: "claude-sonnet",
  virtualApiKeyIds: [],
  members: [
    { provider: "anthropic", priority: 0, enabled: true },
    { provider: "bedrock", priority: 1, enabled: true },
  ],
};
const ROUTER = {
  id: "router-1",
  name: "auto",
  virtualApiKeyIds: [],
  tiers: {
    fast: { provider: "gemini", modelId: "flash" },
    normal: { provider: "anthropic", modelId: "haiku" },
    smart: { provider: "anthropic", modelId: "sonnet" },
  },
};

let providerKeys: unknown[] = [];
let standardKeys: unknown[] = [];
let standardTotal: number | undefined;

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-proxy`, () =>
    HttpResponse.json({ id: "proxy-1", identityProviderId: null }),
  ),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json(providerKeys),
  ),
  http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
    HttpResponse.json([
      {
        id: "claude-a",
        dbId: "m-a",
        displayName: "Claude A",
        provider: "anthropic",
        isFree: false,
      },
      {
        id: "claude-b",
        dbId: "m-b",
        displayName: "Claude B",
        provider: "anthropic",
        isFree: false,
      },
    ]),
  ),
  http.get(`${API_ORIGIN}/api/llm-virtual-keys`, ({ request }) => {
    const keyType = new URL(request.url).searchParams.get("keyType");
    return HttpResponse.json(
      keyType === "standard" ? page(standardKeys, standardTotal) : page([]),
    );
  }),
  http.get(`${API_ORIGIN}/api/oauth-clients`, () =>
    HttpResponse.json(page([])),
  ),
  http.get(`${API_ORIGIN}/api/model-pools`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${API_ORIGIN}/api/limits`, () => HttpResponse.json([])),
  http.get(`${API_ORIGIN}/api/guardrails-deployment`, () =>
    HttpResponse.json({ enabled: false, featureEnabled: true, active: false }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  providerKeys = [ANTHROPIC_KEY, JEV_KEY];
  standardKeys = [JUDGE_KEY];
  standardTotal = undefined;
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useProviderBaseUrls).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useProviderBaseUrls>);
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LlmProxyPage />
    </QueryClientProvider>,
  );
}

function linkedModel(modelId: string, provider: string, apiKeyId: string) {
  return {
    id: `db-${modelId}`,
    modelId,
    provider,
    apiKeys: [{ id: apiKeyId }],
    ignored: false,
    embeddingDimensions: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedEndpoints: null,
  };
}

function card(name: string) {
  return screen.getByRole("region", { name });
}

describe("LLM Proxy dashboard", () => {
  it("links each item to its own page, opening it there", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/model-pools`, () =>
        HttpResponse.json([POOL]),
      ),
      http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
        HttpResponse.json([ROUTER]),
      ),
      // The models each key brings, Jev's decision model among them.
      http.get(`${API_ORIGIN}/api/llm-models`, () =>
        HttpResponse.json([
          linkedModel("claude-a", "anthropic", ANTHROPIC_KEY.id),
          linkedModel("claude-b", "anthropic", ANTHROPIC_KEY.id),
          { ...linkedModel("jev-1", "jev", JEV_KEY.id), outputModalities: [] },
        ]),
      ),
    );
    renderPage();

    // A provider opens the Models page, filtered to its key.
    const anthropic = await screen.findByRole("link", { name: /Anthropic/ });
    expect(anthropic).toHaveAttribute(
      "href",
      "/llm/models?apiKey=pk-anthropic",
    );
    expect(
      await within(anthropic).findByLabelText("2 models"),
    ).toBeInTheDocument();
    // A key that must be signed in again is marked on its provider.
    const jev = screen.getByRole("link", { name: /Jev/ });
    expect(
      within(jev).getByLabelText("Needs reconnecting"),
    ).toBeInTheDocument();
    expect(within(jev).getByLabelText("1 model")).toBeInTheDocument();

    expect(
      await screen.findByRole("link", { name: /claude-sonnet/ }),
    ).toHaveAttribute(
      "href",
      `/llm/model-pools?search=claude-sonnet&edit=${POOL.id}`,
    );
    expect(screen.getByRole("link", { name: /Router\s*auto/ })).toHaveAttribute(
      "href",
      "/llm/auto-routing/router-1",
    );
    expect(
      await screen.findByRole("link", { name: /Judge pipeline/ }),
    ).toHaveAttribute(
      "href",
      "/llm/proxy/virtual-keys?keyType=standard&search=Judge%20pipeline&edit=vk-judge",
    );
    // Set up: no "Not set up" badges.
    expect(screen.queryByText("Not set up")).not.toBeInTheDocument();
  });

  it("sends Manage on pools and routers to either page", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(
        await screen.findByRole("region", { name: "Pools and routers" }),
      ).getByRole("button", { name: "Manage" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Model Pools" }),
    ).toHaveAttribute("href", "/llm/model-pools");
    expect(
      screen.getByRole("menuitem", { name: "Auto Routing" }),
    ).toHaveAttribute("href", "/llm/auto-routing");
  });

  it("sends the rest of the keys to the keys page instead of growing the card", async () => {
    standardTotal = 2003;
    standardKeys = [
      JUDGE_KEY,
      { ...JUDGE_KEY, id: "vk-2", name: "Two" },
      { ...JUDGE_KEY, id: "vk-3", name: "Three" },
    ];
    renderPage();

    expect(
      await screen.findByRole("link", { name: "+2000 more" }),
    ).toHaveAttribute("href", "/llm/proxy/virtual-keys?keyType=standard");
  });

  it("marks a key that has used 80% of its spend limit", async () => {
    standardKeys = [JUDGE_KEY, { ...JUDGE_KEY, id: "vk-cheap", name: "Cheap" }];
    server.use(
      http.get(`${API_ORIGIN}/api/limits`, () =>
        HttpResponse.json([
          spendLimit("vk-judge", 500, 452),
          spendLimit("vk-cheap", 500, 96),
        ]),
      ),
    );
    renderPage();

    const judge = await screen.findByRole("link", { name: /Judge pipeline/ });
    await waitFor(() =>
      expect(within(judge).getByLabelText("Near budget")).toBeInTheDocument(),
    );
    expect(judge).toHaveAttribute("title", "$452.00 of $500.00 used");
    expect(
      within(screen.getByRole("link", { name: /Cheap/ })).queryByLabelText(
        "Near budget",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows Guardrails as enforced when it is turned on", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/guardrails-deployment`, () =>
        HttpResponse.json({
          enabled: true,
          featureEnabled: true,
          active: true,
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Enforced")).toBeInTheDocument();
    expect(
      within(card("Guardrails")).getByRole("link", { name: "Configure" }),
    ).toHaveAttribute("href", "/openappa");
  });
});

describe("LLM Proxy dashboard for a member", () => {
  it("shows the real Guardrails state and skips reads a member cannot make", async () => {
    // A member reads none of organization settings, limits or identity providers.
    const memberLacks = [
      "organizationSettings",
      "llmLimit",
      "identityProvider",
    ];
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: !memberLacks.some((resource) => resource in permissions),
          isPending: false,
        }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    const limitsRequested = vi.fn();
    const identityProvidersRequested = vi.fn();
    server.use(
      http.get(`${API_ORIGIN}/api/guardrails-deployment`, () =>
        HttpResponse.json({
          enabled: true,
          featureEnabled: true,
          active: true,
        }),
      ),
      http.get(`${API_ORIGIN}/api/limits`, () => {
        limitsRequested();
        return HttpResponse.json([]);
      }),
      http.get(`${API_ORIGIN}/api/identity-providers`, () => {
        identityProvidersRequested();
        return HttpResponse.json([]);
      }),
    );
    renderPage();

    expect(await screen.findByText("Enforced")).toBeInTheDocument();
    expect(
      within(card("Virtual keys")).queryByRole("link", {
        name: /Identity providers/,
      }),
    ).not.toBeInTheDocument();
    expect(limitsRequested).not.toHaveBeenCalled();
    expect(identityProvidersRequested).not.toHaveBeenCalled();
  });
});

describe("LLM Proxy dashboard, new organization", () => {
  beforeEach(() => {
    providerKeys = [];
    standardKeys = [];
  });

  it("offers the providers to add a key for, inline", async () => {
    const user = userEvent.setup();
    renderPage();

    const providers = await screen.findByRole("region", {
      name: "Providers and models",
    });
    expect(
      await within(providers).findByText("Not set up"),
    ).toBeInTheDocument();
    expect(
      within(card("Pools and routers")).getByText("Optional"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/A ready-to-run example appears here/),
    ).toBeInTheDocument();
    // A key needs a provider key to map, so creating one waits for it.
    expect(
      within(card("Virtual keys")).getAllByRole("button", {
        name: "+ Create key",
      })[0],
    ).toBeDisabled();

    // "+N more" opens the rest in the card, without leaving the page.
    const more = within(providers).getByRole("button", {
      name: /^\+\d+ more$/,
    });
    await user.click(more);
    expect(more).toHaveTextContent("Show less");
    expect(
      within(providers).getByRole("button", { name: "Mistral AI" }),
    ).toBeInTheDocument();

    await user.click(
      within(providers).getByRole("button", { name: "Anthropic" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add Anthropic API Key" }),
    ).toBeInTheDocument();
  });

  it("offers GitHub Copilot as a personal or an organization subscription", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "GitHub Copilot" }),
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Personal subscription");
  });
});

describe("LLM Proxy dashboard endpoint", () => {
  it("asks for a pool the key calls before any one model", async () => {
    standardKeys = [
      {
        ...JUDGE_KEY,
        providerApiKeys: [
          {
            provider: "anthropic",
            providerApiKeyId: ANTHROPIC_KEY.id,
            providerApiKeyName: ANTHROPIC_KEY.name,
          },
        ],
      },
    ];
    server.use(
      http.get(`${API_ORIGIN}/api/model-pools`, () =>
        HttpResponse.json([{ ...POOL, virtualApiKeyIds: [JUDGE_KEY.id] }]),
      ),
      http.get(`${API_ORIGIN}/api/llm-models`, () =>
        HttpResponse.json([
          linkedModel("claude-a", "anthropic", ANTHROPIC_KEY.id),
        ]),
      ),
    );
    renderPage();

    const url = await screen.findByText(
      /\/v1\/unified-model\/chat\/completions \\/,
    );
    await waitFor(() =>
      expect(url.closest("pre")).toHaveTextContent(
        `-d '{"model": "claude-sonnet", `,
      ),
    );
  });

  it("builds the request from the format and copies it with the reader's real key", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-virtual-keys/vk-judge/value`, () =>
        HttpResponse.json({ value: "arch_judge_secret" }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("combobox", { name: "API format" }),
    );
    await user.type(screen.getByPlaceholderText("Search formats..."), "jev");
    await user.click(await screen.findByRole("option", { name: "Jev" }));

    const url = await screen.findByText(/\/v1\/jev\/decisions \\/);
    const block = url.closest("pre");
    // One request on one line of JSON, as on the prototype.
    expect(block).toHaveTextContent(`-d '{"model": `);
    // Masked on the page.
    expect(block).not.toHaveTextContent("arch_judge_secret");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith(
        expect.stringContaining("Authorization: Bearer arch_judge_secret"),
      ),
    );
  });

  it("moves passthrough off the Unified Model API, which has no route for it", async () => {
    const user = userEvent.setup();
    renderPage();

    const format = await screen.findByRole("combobox", { name: "API format" });
    expect(format).toHaveTextContent("Unified Model API");
    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      await screen.findByRole("option", { name: "Passthrough" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "API format" }),
      ).not.toHaveTextContent("Unified Model API"),
    );
    expect(
      screen.getByRole("combobox", { name: "Passthrough key" }),
    ).toBeInTheDocument();
  });
});

function spendLimit(entityId: string, limitValue: number, used: number) {
  return {
    id: `limit-${entityId}`,
    entityType: "virtual_key",
    entityId,
    limitType: "token_cost",
    limitValue,
    modelUsage: [{ model: "m", tokensIn: 0, tokensOut: 0, cost: used }],
  };
}

function page<T>(data: T[], total = data.length) {
  return {
    data,
    pagination: {
      currentPage: 1,
      limit: 100,
      total,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  };
}
