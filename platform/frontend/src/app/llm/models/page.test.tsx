import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
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
} satisfies archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];

let keyCreated = false;
let modelRequests = 0;

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
