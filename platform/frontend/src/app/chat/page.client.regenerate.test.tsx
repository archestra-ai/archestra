import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
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
import { resolveCanonicalMessageId } from "@/lib/chat/chat-utils";
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

type ChatMessagesProps = Parameters<typeof ChatMessages>[0];

const chatMessagesProps = vi.hoisted(() => ({
  current: undefined as ChatMessagesProps | undefined,
}));

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
// The streaming chat session is the transport boundary.
vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: vi.fn(),
  useGlobalChat: vi.fn(),
}));
// Capture what the page hands the thread so the test can click regenerate.
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: (props: ChatMessagesProps) => {
    chatMessagesProps.current = props;
    return null;
  },
}));

const agent = makeAgent({
  name: "Support Agent",
  scope: "org",
  modelId: "test-model",
  llmApiKeyId: "test-llm-key",
});
const prompt = "Summarize the incident";
// The saved thread keys the message by its DB id; the live chat still holds
// it under the client id it was sent with.
const savedUserMessage = {
  id: "saved-user",
  role: "user",
  parts: [{ type: "text", text: prompt }],
} as UIMessage;
const liveUserMessage = {
  id: "live-user",
  role: "user",
  parts: [{ type: "text", text: prompt }],
} as UIMessage;
const conversation = {
  id: "failed-conversation",
  origin: "user",
  agentId: agent.id,
  agent,
  userId: makeSession().user.id,
  modelId: "test-model",
  chatApiKeyId: "test-llm-key",
  title: "Incident summary",
  messages: [savedUserMessage],
  chatErrors: [],
};
const regeneratedFrom: string[] = [];

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
  http.get("/api/members/default-agent", () =>
    HttpResponse.json({ defaultAgentId: null }),
  ),
  http.get("/api/members/default-model", () => HttpResponse.json(null)),
  http.get("/api/agents/all", () => HttpResponse.json([agent])),
  http.get(`/api/agents/${agent.id}`, () => HttpResponse.json(agent)),
  http.get("/api/agents/credential-readiness", () => HttpResponse.json([])),
  http.get("/api/chat/conversations", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/files", () => HttpResponse.json([])),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
  http.get("/api/chat/conversations/:id", () =>
    HttpResponse.json(conversation),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  regeneratedFrom.length = 0;
  chatMessagesProps.current = undefined;
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
    getSession: () => null,
  } as unknown as ReturnType<typeof useGlobalChat>);
  // A session whose last turn failed: the SDK sits in "error" with the user
  // message still under its client id. Its regenerate resolves that id
  // against the saved thread from its OWN live messages, like the real
  // session does.
  vi.mocked(useChatSession).mockImplementation(function useFailedSession({
    conversationId,
  }) {
    const [messages, setMessages] = useState<UIMessage[]>([liveUserMessage]);
    const liveMessagesRef = useRef(messages);
    liveMessagesRef.current = messages;
    if (!conversationId) return null;
    return {
      messages,
      status: "error",
      error: new Error("Invalid API key"),
      setMessages,
      sendMessage: vi.fn(),
      regenerateUserMessage: async ({ messageId }: { messageId: string }) => {
        const anchorId = resolveCanonicalMessageId({
          messageId,
          liveMessages: liveMessagesRef.current,
          canonicalMessages: [savedUserMessage],
        });
        if (anchorId) regeneratedFrom.push(anchorId);
      },
    } as unknown as ReturnType<typeof useChatSession>;
  });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("regenerating a message whose turn failed re-runs it from the saved message", async () => {
  renderChat();

  // The thread shows the saved message under the live id.
  await waitFor(() =>
    expect(chatMessagesProps.current?.messages).toEqual([
      expect.objectContaining({
        id: "live-user",
        metadata: expect.objectContaining({ persistedMessageId: "saved-user" }),
      }),
    ]),
  );

  await act(async () => {
    await chatMessagesProps.current?.onRegenerateUserMessage?.({
      messageId: "live-user",
      partIndex: 0,
      text: prompt,
    });
  });

  expect(regeneratedFrom).toEqual(["saved-user"]);
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
