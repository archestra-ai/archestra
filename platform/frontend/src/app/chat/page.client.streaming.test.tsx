import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage } from "ai";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { preloadResponseMarkdown } from "@/components/ai-elements/response";
import { useChatSession, useGlobalChat } from "@/lib/chat/global-chat.context";
import { authClient } from "@/lib/clients/auth/auth-client";
import { ConnectivityProvider } from "@/lib/config/connectivity";
import { makeAgent } from "@/mocks/data/agents";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { configSeed, makeConfig } from "@/mocks/data/config";
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import {
  appearanceSettingsSeed,
  organizationSeed,
} from "@/mocks/data/organization";
import { ChatMessages } from "./lazy-parts";
import { ChatPageContent } from "./page.client";

// While a response streams, every chunk re-renders the chat page. Typing in
// the composer lagged badly because each chunk also re-rendered every earlier
// message bubble and the whole composer, keeping the main thread busy. These
// tests pin the render isolation that keeps the composer responsive.

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
// The streaming chat session is the transport boundary: the test drives the
// transcript and status directly instead of opening a stream.
vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: vi.fn(),
  useChatSessionSnapshot: () => null,
  useGlobalChat: vi.fn(),
}));

// Render probes: count how often a message bubble and the composer textarea
// actually re-render. They wrap the real components unchanged.
const renders = { bubbles: 0, composer: 0 };
vi.mock("@/components/ai-elements/message", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ai-elements/message")>();
  return {
    ...actual,
    MessageContent: (props: Parameters<typeof actual.MessageContent>[0]) => {
      renders.bubbles += 1;
      return <actual.MessageContent {...props} />;
    },
  };
});
vi.mock("@/components/ai-elements/prompt-input", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/ai-elements/prompt-input")
    >();
  return {
    ...actual,
    PromptInputTextarea: (
      props: Parameters<typeof actual.PromptInputTextarea>[0],
    ) => {
      renders.composer += 1;
      return <actual.PromptInputTextarea {...props} />;
    },
  };
});

const agent = makeAgent({
  id: "streaming-agent",
  name: "Research Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const conversation = {
  id: "streaming-conversation",
  origin: "user",
  agentId: agent.id,
  agent,
  userId: makeSession().user.id,
  modelId: "test-model",
  chatApiKeyId: "test-llm-key",
  title: "Streaming",
  messages: [],
};

const HISTORY_TURNS = 5;
const transcript = createTranscriptStore();

const server = setupServer(
  http.get("/api/user/permissions", () =>
    HttpResponse.json(
      makeUserPermissions({
        chat: ["read", "create", "update", "delete", "full-view"],
      }),
    ),
  ),
  http.get("/api/organization", () => HttpResponse.json(organizationSeed)),
  http.get("/api/organization/appearance-settings", () =>
    HttpResponse.json(appearanceSettingsSeed),
  ),
  http.get("/api/llm-provider-api-keys", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
  ),
  http.get("/api/llm-provider-api-keys/available", () => HttpResponse.json([])),
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
    HttpResponse.json({ defaultAgentId: null, personalChatAgentId: null }),
  ),
  http.get("/api/agents/chat-roster", () => HttpResponse.json([agent])),
  http.get(`/api/agents/${agent.id}`, () => HttpResponse.json(agent)),
  http.get("/api/agents/:id/tools", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id", () =>
    HttpResponse.json(conversation),
  ),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
  http.get("/health", () => HttpResponse.json({ version: configSeed.version })),
  http.get("/ready", () => HttpResponse.json({ status: "ok" })),
  // Everything else the page fetches is irrelevant to rendering cost.
  ...[
    "/api/:resource",
    "/api/:resource/:id",
    "/api/:resource/:id/:action",
    "/api/:resource/:id/:action/:item",
  ].map((path) =>
    http.get(path, () => HttpResponse.json(null, { status: 404 })),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue(`/chat/${conversation.id}`);
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
  const setMessages = vi.fn();
  const sendMessage = vi.fn();
  const stop = vi.fn();
  vi.mocked(useChatSession).mockImplementation(function useMockSession({
    conversationId,
  }) {
    const state = useSyncExternalStore(transcript.subscribe, transcript.get);
    if (!conversationId) return null;
    return {
      messages: state.messages,
      status: "streaming",
      setMessages,
      sendMessage,
      stop,
    } as unknown as ReturnType<typeof useChatSession>;
  });
  transcript.reset();
});

// The transcript and its markdown are lazy chunks; load them before timing renders.
beforeAll(async () => {
  await Promise.all([ChatMessages.preload(), preloadResponseMarkdown()]);
});

test("a streamed chunk re-renders only the streaming message, not the history or the composer", async () => {
  const composer = await renderStreamingChat();

  resetRenderCounts();
  act(() => transcript.appendToStreamingMessage("more "));
  act(() => transcript.appendToStreamingMessage("tokens "));

  // Streaming markdown wraps each word in its own animated span.
  expect(document.body).toHaveTextContent(/Streaming\s*more\s*tokens/);
  // One bubble (the streaming one) per chunk; the history stays untouched.
  expect(renders.bubbles).toBe(2);
  expect(renders.composer).toBe(0);
  expect(composer).toHaveValue("");
});

test("typing in the composer does not re-render the transcript", async () => {
  const composer = await renderStreamingChat();

  resetRenderCounts();
  for (const value of ["N", "Ne", "Nex", "Next"]) {
    act(() => {
      fireEvent.change(composer, { target: { value } });
    });
  }

  expect(composer).toHaveValue("Next");
  expect(renders.composer).toBeGreaterThan(0);
  expect(renders.bubbles).toBe(0);
});

async function renderStreamingChat() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectivityProvider>
        <ChatPageContent routeConversationId={conversation.id} />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );
  const composer = await screen.findByPlaceholderText(
    "Ask a follow-up...",
    {},
    { timeout: 5_000 },
  );
  expect(
    await screen.findByText(
      `Answer ${HISTORY_TURNS - 1}`,
      {},
      { timeout: 5_000 },
    ),
  ).toBeInTheDocument();
  // The page renders before its permission-gated queries answer; count
  // renders only once they have settled.
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return composer;
}

function resetRenderCounts() {
  renders.bubbles = 0;
  renders.composer = 0;
}

function createTranscriptStore() {
  const initial = (): { messages: UIMessage[] } => ({
    messages: [
      ...Array.from({ length: HISTORY_TURNS }, (_, turn): UIMessage[] => [
        {
          id: `user-${turn}`,
          role: "user",
          parts: [{ type: "text", text: `Question ${turn}` }],
        },
        {
          id: `assistant-${turn}`,
          role: "assistant",
          parts: [{ type: "text", text: `Answer ${turn}` }],
        },
      ]).flat(),
      { id: "user-live", role: "user", parts: [{ type: "text", text: "Go" }] },
      {
        id: "assistant-live",
        role: "assistant",
        parts: [{ type: "text", text: "Streaming " }],
      },
    ],
  });
  let state = initial();
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => publish(initial()),
    // Like the AI SDK, a chunk replaces only the streaming message; earlier
    // messages keep their object identity.
    appendToStreamingMessage(text: string) {
      const history = state.messages.slice(0, -1);
      const live = state.messages[state.messages.length - 1];
      const [part] = live.parts as [{ type: "text"; text: string }];
      publish({
        messages: [
          ...history,
          { ...live, parts: [{ type: "text", text: part.text + text }] },
        ],
      });
    },
  };
}

test("a role without provider, model and agent read never requests them", async () => {
  // The page renders before permissions answer; the queries those grants
  // guard must still wait for them, or such a role gets 403 toasts.
  const requested: string[] = [];
  const onRequest = ({ request }: { request: Request }) => {
    requested.push(new URL(request.url).pathname);
  };
  server.events.on("request:start", onRequest);
  server.use(
    http.get("/api/user/permissions", () =>
      HttpResponse.json({ chat: ["read", "create", "update", "delete"] }),
    ),
  );
  try {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectivityProvider>
          <ChatPageContent routeConversationId={conversation.id} />
        </ConnectivityProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(requested).toContain("/api/user/permissions"));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    for (const path of [
      "/api/llm-provider-api-keys",
      "/api/llm-provider-api-keys/available",
      "/api/llm-models",
      "/api/llm-models/available",
      "/api/agents/chat-roster",
    ]) {
      expect(requested).not.toContain(path);
    }
    // (This file's catch-all 404 handler answers a null body, which other
    // requests turn into a generic toast; only refusals matter here.)
    expect(
      vi
        .mocked(toast.error)
        .mock.calls.filter(([message]) =>
          /permission|forbidden|not allowed/i.test(String(message)),
        ),
    ).toEqual([]);
  } finally {
    server.events.removeListener("request:start", onRequest);
    server.resetHandlers();
  }
});

// These are real page regressions with HTTP fixtures, not live browser proof.
// The subscription owner's key is metadata only; this caller has no direct keys.
const pooledAgent = {
  ...makeAgent({
    id: "pooled-agent",
    name: "Pooled Agent",
    scope: "org",
    modelId: "copilot-model",
    llmApiKeyId: "owner-copilot-key",
    modelPoolId: "agent-pool",
  }),
  resolvedLlmProvider: "github-copilot" as const,
  llmProviderRequiresPerUserCredential: true,
};

async function renderPoolChat({
  existing = false,
  enabled = true,
  pooled = true,
}: {
  existing?: boolean;
  enabled?: boolean;
  pooled?: boolean;
} = {}) {
  const selectedAgent = {
    ...pooledAgent,
    modelPoolId: pooled ? pooledAgent.modelPoolId : null,
  };
  const poolConversation = {
    ...conversation,
    agentId: selectedAgent.id,
    agent: selectedAgent,
    modelId: "shared-model",
    chatApiKeyId: "inherited-shared-key",
    modelPoolId: selectedAgent.modelPoolId,
  };
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json(
        makeConfig({ features: { llmModelPoolsEnabled: enabled } }),
      ),
    ),
    http.get("/api/llm-provider-api-keys", () =>
      HttpResponse.json(enabled && pooled ? [] : [makeLlmProviderApiKey()]),
    ),
    http.get("/api/llm-provider-api-keys/available", ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("includeKeyId")
          ? [
              makeLlmProviderApiKey({
                id: "owner-copilot-key",
                provider: "github-copilot",
                userId: "another-owner",
              }),
            ]
          : [],
      ),
    ),
    http.get("/api/llm-models/available", () =>
      HttpResponse.json([
        {
          id: "gpt-4.1",
          dbId: "copilot-model",
          displayName: "GPT 4.1",
          provider: "github-copilot",
          requiresUserConnection: true,
          isConnected: false,
        },
      ]),
    ),
    http.get("/api/members/default-agent", () =>
      HttpResponse.json({ defaultAgentId: selectedAgent.id }),
    ),
    http.get("/api/members/default-model", () => HttpResponse.json(null)),
    http.get("/api/agents/chat-roster", () =>
      HttpResponse.json([selectedAgent]),
    ),
    http.get(`/api/agents/${selectedAgent.id}`, () =>
      HttpResponse.json(selectedAgent),
    ),
    http.get("/api/chat/conversations/:id", () =>
      HttpResponse.json(poolConversation),
    ),
    http.get("/api/model-pools/available", () => HttpResponse.json([])),
    http.get("/api/agents/:id/delegations", () => HttpResponse.json([])),
    http.get("/api/internal_mcp_catalog/registry/issue-index", () =>
      HttpResponse.json({ catalogItems: [], servers: [] }),
    ),
    http.get("/api/chat/conversations/:id/files", () => HttpResponse.json([])),
  );
  const path = existing ? `/chat/${conversation.id}` : "/chat";
  window.history.replaceState(null, "", path);
  vi.mocked(usePathname).mockReturnValue(path);
  vi.mocked(useChatSession).mockReturnValue(
    existing
      ? ({
          messages: [],
          status: "ready",
          setMessages: vi.fn(),
          sendMessage: vi.fn(),
          stop: vi.fn(),
        } as unknown as ReturnType<typeof useChatSession>)
      : null,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectivityProvider>
        <ChatPageContent
          routeConversationId={existing ? conversation.id : undefined}
        />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );
  await screen.findAllByText("Pooled Agent", {}, { timeout: 5_000 });
  const composer = await screen.findByRole("textbox", {}, { timeout: 5_000 });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  fireEvent.change(composer, { target: { value: "Hello through the pool" } });
  return screen.getByRole("button", { name: "Submit" });
}

test("a fresh pooled chat submits without connecting the owner's subscription or adding a direct key", async () => {
  const submitted: unknown[] = [];
  server.use(
    http.post("/api/chat/conversations", async ({ request }) => {
      submitted.push(await request.json());
      // Stop at the HTTP boundary rather than create a fake streaming session.
      return HttpResponse.json(
        { error: "Fixture stops after submission" },
        { status: 400 },
      );
    }),
  );
  const submit = await renderPoolChat();
  expect(submit).toBeEnabled();
  expect(screen.queryByText("Connect an LLM provider")).not.toBeInTheDocument();
  fireEvent.click(submit);
  await waitFor(() =>
    expect(submitted).toEqual([
      expect.objectContaining({
        agentId: pooledAgent.id,
        modelPoolId: "agent-pool",
      }),
    ]),
  );
});

test("an existing pooled chat retains its inherited shared selection without direct keys", async () => {
  const submit = await renderPoolChat({ existing: true });
  expect(submit).toBeEnabled();
  expect(screen.queryByText("Connect an LLM provider")).not.toBeInTheDocument();
});

test.each([
  { pooled: false, enabled: true },
  { pooled: true, enabled: false },
])("a direct or disabled-pool subscription still requires the caller to connect (%j)", async (settings) => {
  expect(await renderPoolChat(settings)).toBeDisabled();
});
