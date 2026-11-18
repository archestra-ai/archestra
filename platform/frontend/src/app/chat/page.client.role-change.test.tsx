import { archestraApiClient, E2eTestId } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { useChatSession, useGlobalChat } from "@/lib/chat/global-chat.context";
import { authClient } from "@/lib/clients/auth/auth-client";
import { ConnectivityProvider } from "@/lib/config/connectivity";
import { makeAgent, makeAgentsList } from "@/mocks/data/agents";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { configSeed } from "@/mocks/data/config";
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import {
  appearanceSettingsSeed,
  organizationSeed,
} from "@/mocks/data/organization";
import { ChatPageContent } from "./page.client";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
// The streaming chat session is the transport boundary.
vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: vi.fn(),
  useChatSessionSnapshot: () => null,
  useGlobalChat: vi.fn(),
}));

const ADD_PROVIDER_HEADING = "Connect an LLM provider";
const CHAT_PERMISSIONS: ReturnType<typeof makeUserPermissions>["chat"] = [
  "read",
  "create",
  "update",
  "delete",
  "full-view",
];

const defaultAgent = makeAgent({
  id: "default-agent",
  name: "Default Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
// What the server says the viewer may do now, and when it says so.
let currentPermissions = makeUserPermissions();
let releasePermissions: () => void = () => {};
let permissionsReleased: Promise<void> = Promise.resolve();

const server = setupServer(
  http.get("/api/teams", () =>
    HttpResponse.json({ data: [], pagination: { total: 0 } }),
  ),
  http.get("/api/environments", () => HttpResponse.json([])),
  http.get("/health", () => HttpResponse.json({ status: "ok" })),
  http.get("/ready", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/llm-provider-api-keys/available", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
  ),
  http.get("/api/llm-provider-api-keys", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
  ),
  http.get("/api/agents", () => HttpResponse.json(makeAgentsList())),
  http.get("/api/agents/:id/delegations", () => HttpResponse.json([])),
  http.get("/api/agents/:id/tools", () => HttpResponse.json([])),
  http.get("/api/agents/chat-roster", () => HttpResponse.json([defaultAgent])),
  http.get("/api/agents/credential-readiness", () => HttpResponse.json([])),
  http.get("/api/agents/:id", () => HttpResponse.json(defaultAgent)),
  http.get("/api/internal_mcp_catalog/registry/issue-index", () =>
    HttpResponse.json({ catalogItems: [], servers: [] }),
  ),
  http.get("/api/internal_mcp_catalog", () => HttpResponse.json([])),
  http.get("/api/mcp_server", () => HttpResponse.json([])),
  http.get("/api/bootstrap", () => HttpResponse.json(null, { status: 401 })),
  http.get("/api/guardrails-deployment", () =>
    HttpResponse.json({ enabled: false, featureEnabled: false, active: false }),
  ),
  http.get("/api/user/permissions", async () => {
    await permissionsReleased;
    return HttpResponse.json(currentPermissions);
  }),
  http.get("/api/resource-permissions", () => HttpResponse.json([])),
  http.get("/api/organization", () => HttpResponse.json(organizationSeed)),
  http.get("/api/organization/appearance-settings", () =>
    HttpResponse.json(appearanceSettingsSeed),
  ),
  http.get("/api/llm-models/available", () =>
    HttpResponse.json([
      {
        id: "test-model",
        dbId: "test-model",
        displayName: "Test model",
        provider: "anthropic",
        isBest: true,
      },
    ]),
  ),
  http.get("/api/members/default-agent", () =>
    HttpResponse.json({ defaultAgentId: defaultAgent.id }),
  ),
  http.get("/api/members/default-model", () => HttpResponse.json(null)),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  permissionsReleased = new Promise((resolve) => {
    releasePermissions = resolve;
  });
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue("/chat");
  window.history.replaceState(null, "", "/chat");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.mocked(useGlobalChat).mockReturnValue({
    animatingTitleIds: new Set<string>(),
  } as unknown as ReturnType<typeof useGlobalChat>);
  vi.mocked(useChatSession).mockReturnValue(null);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("a tab opened under a role without provider keys shows the composer once the viewer's role grants them", async () => {
  currentPermissions = makeUserPermissions({ chat: CHAT_PERMISSIONS });
  renderChatInOpenTab({
    cachedPermissions: makeUserPermissions({
      chat: CHAT_PERMISSIONS,
      llmProviderApiKey: [],
    }),
  });

  // The cached map refuses the key lists, but the server has not repeated it.
  await settle();
  expect(screen.queryByText(ADD_PROVIDER_HEADING)).not.toBeInTheDocument();

  await act(async () => releasePermissions());

  expect(
    await screen.findByTestId(E2eTestId.ChatPromptTextarea),
  ).toBeInTheDocument();
  expect(screen.queryByText(ADD_PROVIDER_HEADING)).not.toBeInTheDocument();
});

test("a viewer whose role still withholds provider keys is asked to connect one", async () => {
  const withoutProviderKeys = makeUserPermissions({
    chat: CHAT_PERMISSIONS,
    llmProviderApiKey: [],
  });
  currentPermissions = withoutProviderKeys;
  renderChatInOpenTab({ cachedPermissions: withoutProviderKeys });

  await act(async () => releasePermissions());

  expect(
    (await screen.findAllByText(ADD_PROVIDER_HEADING)).length,
  ).toBeGreaterThan(0);
});

/** Let the queries that are not held back answer. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

/**
 * The chat page reached by an in-app navigation: the tab already holds the
 * session and the permission map it fetched a minute ago.
 */
function renderChatInOpenTab(params: {
  cachedPermissions: ReturnType<typeof makeUserPermissions>;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    },
  });
  const fetchedAt = Date.now() - 60_000;
  client.setQueryData(authQueryKeys.session(), makeSession(), {
    updatedAt: fetchedAt,
  });
  client.setQueryData(
    authQueryKeys.userPermissions(),
    params.cachedPermissions,
    { updatedAt: fetchedAt },
  );
  return render(
    <QueryClientProvider client={client}>
      <ConnectivityProvider>
        <ChatPageContent />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );
}
