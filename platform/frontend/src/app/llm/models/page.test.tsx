import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
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
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import ModelsPage from "./page";

const API_ORIGIN = "http://localhost:9000";

const providerKey = {
  id: "provider-key-1",
  organizationId: "organization-1",
  name: "Anthropic",
  provider: "anthropic",
  secretId: "secret-1",
  scope: "personal",
  userId: "user-1",
  teamId: null,
  baseUrl: null,
  inferenceBaseUrl: null,
  extraHeaders: null,
  isSystem: false,
  isPrimary: false,
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
  createdBy: null,
} satisfies archestraApiTypes.CreateLlmProviderApiKeyResponses["200"];

const model = {
  id: "model-1",
  externalId: "claude-test",
  provider: "anthropic",
  modelId: "claude-test",
  description: null,
  contextLength: 200_000,
  outputLength: 8_192,
  customContextLength: null,
  customOutputLength: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsToolCalling: true,
  supportsReasoningEffort: false,
  supportedEndpoints: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  cacheReadPricePerToken: null,
  cacheWritePricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  customPricePerMillionCacheRead: null,
  customPricePerMillionCacheWrite: null,
  ignored: false,
  embeddingDimensions: null,
  defaultParameters: null,
  configuredParameters: null,
  discoveredViaLlmProxy: false,
  lastSyncedAt: "2026-08-27T12:00:00.000Z",
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
  isBest: true,
  apiKeys: [
    {
      id: providerKey.id,
      name: providerKey.name,
      provider: providerKey.provider,
      scope: providerKey.scope,
      isSystem: false,
    },
  ],
  teams: [],
  users: [],
  pricePerMillionInput: "3",
  pricePerMillionOutput: "15",
  isCustomPrice: false,
  priceSource: "models_dev",
  pricePerMillionCacheRead: null,
  pricePerMillionCacheWrite: null,
  cachePriceSource: "models_dev",
  isFree: false,
  effectiveContextLength: 200_000,
  embeddingClientImageCapable: null,
  labels: [],
} satisfies archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];

let keyCreated = false;
let modelRequests = 0;
const routerPush = vi.fn();

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-models`, () => {
    modelRequests += 1;
    return HttpResponse.json(keyCreated ? [model] : []);
  }),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json(keyCreated ? [providerKey] : []),
  ),
  http.post(`${API_ORIGIN}/api/llm-provider-api-keys`, () => {
    keyCreated = true;
    return HttpResponse.json(providerKey);
  }),
);

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("sonner");

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  vi.clearAllMocks();
  keyCreated = false;
  modelRequests = 0;
  vi.mocked(usePathname).mockReturnValue("/llm/models");
  vi.mocked(useRouter).mockReturnValue({
    push: routerPush,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useFeature).mockReturnValue(false);
  vi.mocked(useProviderBaseUrls).mockReturnValue({
    data: {},
  } as ReturnType<typeof useProviderBaseUrls>);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useTeams>);
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("ModelsPage", () => {
  it("reports partial refresh failures and updates the persistent reconnect state", async () => {
    keyCreated = true;
    let rejected = false;
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          {
            ...providerKey,
            provider: "openai",
            subscriptionKind: "chatgpt",
            requiresReauthentication: rejected,
          },
        ]),
      ),
      http.post(`${API_ORIGIN}/api/llm-models/sync`, () => {
        rejected = true;
        return HttpResponse.json({
          success: false,
          failures: [
            {
              apiKeyId: providerKey.id,
              name: providerKey.name,
              provider: providerKey.provider,
              requiresReauthentication: true,
            },
          ],
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(model.modelId);
    await user.click(screen.getByRole("button", { name: "Refresh Models" }));
    expect(
      await screen.findByText("Some models could not be refreshed"),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Reconnect" }),
    ).toBeVisible();
    expect(screen.getByText(model.modelId)).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it.each([
    ["openai", "chatgpt", "ChatGPT", "Sign in with ChatGPT"],
    [
      "github-copilot",
      "github-copilot",
      "GitHub Copilot",
      "Sign in with GitHub",
    ],
    [
      "microsoft-365-copilot",
      "microsoft-365-copilot",
      "Microsoft 365 Copilot",
      "Sign in with Microsoft",
    ],
    ["xai", "x-premium", "SuperGrok", "Sign in with Grok"],
  ])("opens %s reconnect in place", async (provider, subscriptionKind, name, signInLabel) => {
    keyCreated = true;
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          {
            ...providerKey,
            provider,
            subscriptionKind,
            name,
            requiresReauthentication: true,
          },
        ]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(
      await screen.findByRole("heading", { name: `Reconnect ${name}` }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: signInLabel })).toBeVisible();
    expect(screen.queryByText("Advanced settings")).not.toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("adds a provider key from the empty state and loads its models", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Add API Key" }),
    );
    expect(screen.getByRole("heading", { name: "Add API Key" })).toBeVisible();

    await user.type(screen.getByLabelText("API Key"), "test-api-key");
    await user.click(screen.getByRole("button", { name: "Test & Create" }));

    expect(await screen.findByText(model.modelId)).toBeVisible();
    await waitFor(() => expect(modelRequests).toBeGreaterThanOrEqual(2));
    expect(
      screen.queryByRole("button", { name: "Add API Key" }),
    ).not.toBeInTheDocument();
  });

  it("renders the provider icon inline before the model ID", async () => {
    keyCreated = true;
    renderPage();

    expect(await screen.findByText(model.modelId)).toBeVisible();
    // The icon moved out of its own column and now sits in the Model ID cell.
    expect(screen.getByRole("img", { name: "Anthropic" })).toBeVisible();
  });

  it("shows input and output prices in one combined column", async () => {
    keyCreated = true;
    renderPage();

    expect(await screen.findByText(model.modelId)).toBeVisible();
    // Input ($3) and output ($15) share a single cell, like Cache R/W.
    expect(screen.getByText("$3.00 / $15.00")).toBeVisible();
    expect(screen.getByText("$/M In/Out")).toBeVisible();
    expect(screen.queryByText("$/M Input")).not.toBeInTheDocument();
    expect(screen.queryByText("$/M Output")).not.toBeInTheDocument();
  });

  it("hydrates filter state from the URL query params", async () => {
    keyCreated = true;
    // A chat model filtered to embedding-only should drop out entirely.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("modelType=embedding") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    renderPage();

    expect(
      await screen.findByText("No models match your filters"),
    ).toBeVisible();
    expect(screen.queryByText(model.modelId)).not.toBeInTheDocument();
  });

  it("syncs the search filter to the URL query params", async () => {
    keyCreated = true;
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByPlaceholderText(/search models/i),
      "claude",
    );

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        expect.stringContaining("search=claude"),
        { scroll: false },
      ),
    );
  });

  it("keeps a free-only deep link while the provider keys load", async () => {
    keyCreated = true;
    // An OpenRouter key makes the free-only filter valid — but it resolves
    // after first render, when apiKeys is still empty.
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          { ...providerKey, provider: "openrouter", name: "OpenRouter" },
        ]),
      ),
    );
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("freeOnly=true") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    renderPage();

    // The toggle hydrates from the URL and stays on once keys resolve...
    const toggle = await screen.findByRole("switch", { name: /free only/i });
    await waitFor(() => expect(toggle).toBeChecked());
    // ...and the deep link is never stripped while keys were loading.
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("clears an active label filter from the model collection", async () => {
    keyCreated = true;
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("labels=stage%3Aproduction") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    const user = userEvent.setup();

    renderPage();
    await user.click(await screen.findByRole("button", { name: "Clear" }));

    expect(routerPush).toHaveBeenCalledWith("/llm/models", { scroll: false });
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ModelsPage />
    </QueryClientProvider>,
  );
}
