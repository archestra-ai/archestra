import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
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
  http.get("/api/agents/all", () => HttpResponse.json([agent])),
  http.get(`/api/agents/${agent.id}`, () => HttpResponse.json(agent)),
  http.get("/api/agents/:id/tools", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id", () =>
    HttpResponse.json(conversation),
  ),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
  // Everything else the page fetches is irrelevant to rendering cost.
  http.get(/\/api\//, () => HttpResponse.json(null, { status: 404 })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
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
    getSession: () => null,
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
  render(
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
  const composer = await screen.findByPlaceholderText(
    "Ask a follow-up...",
    {},
    { timeout: 5_000 },
  );
  expect(
    await screen.findByText(`Answer ${HISTORY_TURNS - 1}`),
  ).toBeInTheDocument();
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
