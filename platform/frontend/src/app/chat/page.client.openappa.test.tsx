import { archestraApiClient, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { StrictMode, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { useChatSession, useGlobalChat } from "@/lib/chat/global-chat.context";
import { authClient } from "@/lib/clients/auth/auth-client";
import { ConnectivityProvider } from "@/lib/config/connectivity";
import { makeAgent } from "@/mocks/data/agents";
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
// The streaming chat session is the transport boundary: record what the page
// sends instead of opening a stream.
vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: vi.fn(),
  useGlobalChat: vi.fn(),
}));

vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: () => null,
}));

const agent = makeAgent({
  name: "OpenAPPA Configuration Agent",
  scope: "org",
  builtIn: true,
  builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
  authorId: null,
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const otherAgent = makeAgent({
  id: "research-agent",
  name: "Research Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const conversation = {
  id: "configuration-conversation",
  origin: "user",
  agentId: agent.id,
  agent,
  userId: makeSession().user.id,
  modelId: "test-model",
  chatApiKeyId: "test-llm-key",
  title: "Review policy",
  messages: [],
};
const openingPrompt =
  "Review how my policy governs Research gateway (mcp_gateway e8340e76-19fc-444d-ac4e-a817c1e78c3c).";
const createBodies: unknown[] = [];
const sent: UIMessage[] = [];

const server = setupServer(
  http.get("/api/teams", () =>
    HttpResponse.json({ data: [], pagination: { total: 0 } }),
  ),
  http.get("/api/environments", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/openappa-status", () =>
    HttpResponse.json(null),
  ),
  http.get("/health", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/llm-provider-api-keys/available", () => HttpResponse.json([])),
  http.get("/api/agents/:id/tools", () => HttpResponse.json([])),
  http.get("/api/internal_mcp_catalog", () => HttpResponse.json([])),
  http.get("/api/mcp_server", () => HttpResponse.json([])),
  http.get("/api/resource-permissions/conversation/:id", () =>
    HttpResponse.json({ grants: [], inheritedGrants: [] }),
  ),
  http.get("/ready", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/user/permissions", () =>
    HttpResponse.json(makeUserPermissions({ chatAgentPicker: ["enable"] })),
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
  http.get("/api/members/default-agent", () =>
    HttpResponse.json({ defaultAgentId: null }),
  ),
  http.get("/api/members/default-model", () => HttpResponse.json(null)),
  http.get("/api/agents/all", () => HttpResponse.json([agent])),
  http.get(`/api/agents/${agent.id}`, () => HttpResponse.json(agent)),
  http.get("/api/agents/credential-readiness", () => HttpResponse.json([])),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/files", () => HttpResponse.json([])),
  http.get("/api/config", () =>
    HttpResponse.json({
      ...configSeed,
      features: { ...configSeed.features, openappaEnabled: true },
    }),
  ),
  http.post("/api/chat/conversations", async ({ request }) => {
    createBodies.push(await request.json());
    return HttpResponse.json(conversation);
  }),
  http.get("/api/chat/conversations/:id", () =>
    HttpResponse.json(conversation),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  createBodies.length = 0;
  sent.length = 0;
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue("/chat");
  window.history.replaceState(null, "", "/chat");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams({
      agentId: agent.id,
      user_prompt: openingPrompt,
    }) as unknown as ReturnType<typeof useSearchParams>,
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
    getSession: () => null,
  } as unknown as ReturnType<typeof useGlobalChat>);
  vi.mocked(useChatSession).mockImplementation(function useMockSession({
    conversationId,
    initialMessages = [],
  }) {
    const [messages, setMessages] = useState<UIMessage[]>([]);
    if (!conversationId) return null;
    const history = messages.length > 0 ? messages : initialMessages;
    return {
      messages: history,
      status: "ready",
      setMessages,
      sendMessage: (message: Omit<UIMessage, "id">) => {
        const withId = { ...message, id: `m${sent.length}` } as UIMessage;
        sent.push(withId);
        setMessages([...history, withId]);
      },
    } as unknown as ReturnType<typeof useChatSession>;
  });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("a configuration agent launch uses ordinary creation and chat controls", async () => {
  const user = userEvent.setup();
  renderChat();

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(createBodies).toEqual([
    expect.objectContaining({
      agentId: agent.id,
      modelId: "test-model",
      chatApiKeyId: "test-llm-key",
    }),
  ]);
  expect(createBodies[0]).not.toHaveProperty("origin");
  expect(`${window.location.pathname}${window.location.search}`).toBe(
    "/chat/configuration-conversation",
  );
  expect(sent[0]).toMatchObject({
    parts: [{ type: "text", text: openingPrompt }],
  });
  expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Chat actions" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", {
      name: "OpenAPPA Configuration Agent",
    }),
  ).toBeEnabled();

  await user.type(
    await screen.findByPlaceholderText("Ask a follow-up..."),
    "Now tighten it{Enter}",
  );
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({
    parts: [{ type: "text", text: "Now tighten it" }],
  });
});

test.each([
  "plain chat",
  "configuration launch",
])("a new %s lets the user switch away from the configuration agent", async (launch) => {
  const user = userEvent.setup();
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      launch === "configuration launch" ? { agentId: agent.id } : {},
    ) as unknown as ReturnType<typeof useSearchParams>,
  );
  server.use(
    http.get("/api/agents/all", () => HttpResponse.json([agent, otherAgent])),
    http.get(`/api/agents/${otherAgent.id}`, () =>
      HttpResponse.json(otherAgent),
    ),
  );
  renderChat();

  await user.click(
    await screen.findByRole("combobox", {
      name: "OpenAPPA Configuration Agent",
    }),
  );
  await user.click(
    await screen.findByRole("option", { name: /Research Agent/ }),
  );
  expect(
    await screen.findByRole("combobox", { name: "Research Agent" }),
  ).toBeEnabled();
  expect(createBodies).toHaveLength(0);
});

test("an ordinary launch ready on mount creates and sends once under StrictMode", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["config"], configSeed);
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConnectivityProvider>
          <ChatPageContent />
        </ConnectivityProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(createBodies).toHaveLength(1);
  expect(createBodies[0]).toMatchObject({
    agentId: agent.id,
    modelId: "test-model",
  });
  expect(window.location.pathname).toBe("/chat/configuration-conversation");
});

test("a saved configuration-agent conversation accepts a normal follow-up without a launch URL", async () => {
  const user = userEvent.setup();
  vi.mocked(usePathname).mockReturnValue(`/chat/${conversation.id}`);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  const updates: unknown[] = [];
  server.use(
    http.get("/api/agents/all", () => HttpResponse.json([agent, otherAgent])),
    http.get(`/api/agents/${otherAgent.id}`, () =>
      HttpResponse.json(otherAgent),
    ),
    http.patch("/api/chat/conversations/:id", async ({ request }) => {
      const body = (await request.json()) as { agentId?: string };
      if (body.agentId) updates.push(body);
      return HttpResponse.json({
        ...conversation,
        ...body,
        agent: body.agentId === otherAgent.id ? otherAgent : agent,
      });
    }),
    http.get("/api/chat/conversations/:id", () =>
      HttpResponse.json({
        ...conversation,
        messages: [
          {
            id: "saved-user",
            role: "user",
            parts: [{ type: "text", text: openingPrompt }],
          },
          {
            id: "saved-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "The gateway has three tools." }],
          },
        ],
      }),
    ),
  );
  renderChat(conversation.id);
  const composer = await screen.findByPlaceholderText("Ask a follow-up...");
  expect(sent).toHaveLength(0);
  await user.type(composer, "Now tighten it{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(createBodies).toHaveLength(0);
  expect(sent[0]).toMatchObject({
    parts: [{ type: "text", text: "Now tighten it" }],
  });
  await user.click(
    screen.getByRole("combobox", { name: "OpenAPPA Configuration Agent" }),
  );
  await user.click(
    await screen.findByRole("option", { name: /Research Agent/ }),
  );
  await waitFor(() =>
    expect(updates).toEqual([
      expect.objectContaining({ agentId: otherAgent.id }),
    ]),
  );
});

function renderChat(routeConversationId?: string) {
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
        <ChatPageContent routeConversationId={routeConversationId} />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );
}
