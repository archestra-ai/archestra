import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import type { ChatMessages } from "@/components/chat/chat-messages";
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

type ChatMessagesProps = Parameters<typeof ChatMessages>[0];

const threadAgentNames = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
// The streaming chat session is the transport boundary.
vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: vi.fn(),
  useChatSessionSnapshot: () => null,
  useGlobalChat: vi.fn(),
}));
// Record which agent the thread is told it belongs to on every render.
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: (props: ChatMessagesProps) => {
    threadAgentNames.push(props.agentName);
    return null;
  },
}));

// The member's default: what a new chat starts with, and what a reloaded
// conversation used to show until its own agent arrived.
const defaultAgent = makeAgent({
  id: "default-agent",
  name: "Default Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const conversationAgent = makeAgent({
  id: "conversation-agent",
  name: "Conversation Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const conversation = {
  id: "reloaded-conversation",
  origin: "user",
  agentId: conversationAgent.id,
  agent: conversationAgent,
  userId: makeSession().user.id,
  modelId: "test-model",
  chatApiKeyId: "test-llm-key",
  title: "Reloaded",
  messages: [
    { id: "saved-user", role: "user", parts: [{ type: "text", text: "Hi" }] },
  ],
  chatErrors: [],
};
const ISSUE_INDEX = { catalogItems: [], servers: [] };
const served = new Set<string>();
let releaseConversation: () => void = () => {};
let conversationReleased: Promise<void> = Promise.resolve();

const server = setupServer(
  http.get("/api/teams", () =>
    HttpResponse.json({ data: [], pagination: { total: 0 } }),
  ),
  http.get("/api/environments", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/openappa-status", () =>
    HttpResponse.json(null),
  ),
  http.get("/health", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/llm-provider-api-keys/available", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
  ),
  http.get("/api/agents", () => HttpResponse.json(makeAgentsList())),
  http.get("/api/agents/:id/delegations", () => HttpResponse.json([])),
  http.get("/api/internal_mcp_catalog/registry/issue-index", () =>
    HttpResponse.json(ISSUE_INDEX),
  ),
  http.get("/api/bootstrap", () => HttpResponse.json(null, { status: 401 })),
  http.get("/api/guardrails-deployment", () =>
    HttpResponse.json({ enabled: false, featureEnabled: false, active: false }),
  ),
  http.get("/api/agents/:id/tools", () => HttpResponse.json([])),
  http.get("/api/internal_mcp_catalog", () => HttpResponse.json([])),
  http.get("/api/mcp_server", () => HttpResponse.json([])),
  http.get("/api/resource-permissions/conversation/:id", () =>
    HttpResponse.json({ grants: [], inheritedGrants: [] }),
  ),
  http.get("/ready", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/user/permissions", () =>
    HttpResponse.json(
      makeUserPermissions({
        chat: ["read", "create", "update", "delete", "full-view"],
      }),
    ),
  ),
  http.get("/api/resource-permissions", () => HttpResponse.json([])),
  http.get("/api/organization", () => HttpResponse.json(organizationSeed)),
  http.get("/api/organization/appearance-settings", () =>
    HttpResponse.json(appearanceSettingsSeed),
  ),
  http.get("/api/llm-provider-api-keys", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
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
  http.get("/api/members/default-agent", () => {
    served.add("default-agent");
    return HttpResponse.json({ defaultAgentId: defaultAgent.id });
  }),
  http.get("/api/members/default-model", () => HttpResponse.json(null)),
  http.get("/api/agents/chat-roster", () => {
    served.add("roster");
    return HttpResponse.json([defaultAgent, conversationAgent]);
  }),
  http.get("/api/agents/:id", ({ params }) =>
    HttpResponse.json(
      [defaultAgent, conversationAgent].find((a) => a.id === params.id),
    ),
  ),
  http.get("/api/agents/credential-readiness", () => HttpResponse.json([])),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/files", () => HttpResponse.json([])),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
  http.get("/api/chat/conversations/:id", async () => {
    await conversationReleased;
    return HttpResponse.json(conversation);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  threadAgentNames.length = 0;
  served.clear();
  conversationReleased = new Promise((resolve) => {
    releaseConversation = resolve;
  });
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue(`/chat/${conversation.id}`);
  window.history.replaceState(null, "", `/chat/${conversation.id}`);
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

test("reloading a conversation never shows the default agent before its own", async () => {
  renderChat();

  // Everything but the conversation loads, the default agent included, and
  // the page settles on it.
  await waitFor(() => {
    expect(served).toContain("roster");
    expect(served).toContain("default-agent");
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(threadAgentNames).not.toContain("Default Agent");
  expect(screen.queryByText("Default Agent")).not.toBeInTheDocument();

  await act(async () => releaseConversation());

  await waitFor(() =>
    expect(threadAgentNames.at(-1)).toBe("Conversation Agent"),
  );
  expect(threadAgentNames).not.toContain("Default Agent");
  expect(screen.queryByText("Default Agent")).not.toBeInTheDocument();
});

function renderChat() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ConnectivityProvider>
        <ChatPageContent routeConversationId={conversation.id} />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );
}
