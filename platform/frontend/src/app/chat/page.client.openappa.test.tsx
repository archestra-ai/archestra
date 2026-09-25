import { archestraApiClient } from "@archestra/shared";
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
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { adminPermissionsSeed, makeSession } from "@/mocks/data/auth";
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

const targetId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";
const conversation = {
  id: "policy-conversation-1",
  origin: "openappa",
  agentId: "openappa-agent",
  agent: { id: "openappa-agent", name: "OpenAPPA Configuration Agent" },
  userId: makeSession().user.id,
  modelId: null,
  title: null,
  messages: [],
};
const createBodies: unknown[] = [];
const sent: UIMessage[] = [];

const server = setupServer(
  http.get("/ready", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/user/permissions", () =>
    HttpResponse.json(adminPermissionsSeed),
  ),
  http.get("/api/resource-permissions", () => HttpResponse.json([])),
  http.get("/api/organization", () => HttpResponse.json(organizationSeed)),
  http.get("/api/organization/appearance-settings", () =>
    HttpResponse.json(appearanceSettingsSeed),
  ),
  http.get("/api/llm-provider-api-keys", () =>
    HttpResponse.json([makeLlmProviderApiKey()]),
  ),
  http.get("/api/llm-models/available", () => HttpResponse.json([])),
  http.get("/api/members/default-agent", () =>
    HttpResponse.json({ defaultAgentId: null }),
  ),
  http.get("/api/members/default-model", () => HttpResponse.json(null)),
  http.get("/api/agents/all", () => HttpResponse.json([])),
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
  http.get("/api/openappa/coverage/entities", () =>
    HttpResponse.json({
      data: [
        {
          id: targetId,
          name: "Research gateway",
          type: "mcp_gateway",
          scope: "org",
          icon: null,
          toolCount: 3,
          governedCount: 2,
          fallbackCount: 1,
          builtInCount: 1,
          rules: {
            root: 1,
            battery: 1,
            notEnforced: 0,
            catchAll: 1,
            builtInFallback: 0,
          },
          autoMode: true,
        },
      ],
      pagination: {
        currentPage: 1,
        limit: 1,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  createBodies.length = 0;
  sent.length = 0;
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue("/chat");
  window.history.replaceState(null, "", "/chat?openappa=1&from=openappa");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams({
      openappa: "1",
      targetType: "mcp_gateway",
      targetId,
      openappaPrompt: "reviewCoverage",
      from: "openappa",
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
  }) {
    const [messages, setMessages] = useState<UIMessage[]>([]);
    if (!conversationId) return null;
    return {
      messages,
      status: "ready",
      setMessages,
      sendMessage: (message: Omit<UIMessage, "id">) => {
        const withId = { ...message, id: `m${sent.length}` } as UIMessage;
        sent.push(withId);
        setMessages((current) => [...current, withId]);
      },
    } as unknown as ReturnType<typeof useChatSession>;
  });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("an OpenAPPA launch key starts a scoped policy chat with its prompt, keeps the scope on follow-ups, and keeps the link back to OpenAPPA", async () => {
  const user = userEvent.setup();
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
        <ChatPageContent />
      </ConnectivityProvider>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(createBodies).toEqual([{ origin: "openappa" }]);
  expect(`${window.location.pathname}${window.location.search}`).toBe(
    "/chat/policy-conversation-1?from=openappa",
  );
  const target = { kind: "mcp_gateway", id: targetId };
  expect(sent[0]).toMatchObject({
    parts: [
      {
        type: "text",
        text: resolveOpenAppaLaunchPrompt("reviewCoverage", {
          kind: "mcp_gateway",
          name: "Research gateway",
        }),
      },
    ],
    metadata: { openAppaPolicyTarget: target },
  });

  await user.type(
    await screen.findByPlaceholderText("Ask about or change your policy…"),
    "Now tighten it{Enter}",
  );
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({
    parts: [{ type: "text", text: "Now tighten it" }],
    metadata: { openAppaPolicyTarget: target },
  });
});

test("a launch that is ready on mount still opens the conversation under StrictMode", async () => {
  // The real click: config is already cached and an untargeted prompt needs
  // no fetch, so the create fires from the mount effect that StrictMode
  // replays.
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams({
      openappa: "1",
      openappaPrompt: "reviewPolicy",
      from: "openappa",
    }) as unknown as ReturnType<typeof useSearchParams>,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["config"], {
    ...configSeed,
    features: { ...configSeed.features, openappaEnabled: true },
  });
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
  expect(createBodies).toEqual([{ origin: "openappa" }]);
  expect(`${window.location.pathname}${window.location.search}`).toBe(
    "/chat/policy-conversation-1?from=openappa",
  );
  expect(sent[0]).toMatchObject({
    parts: [
      { type: "text", text: resolveOpenAppaLaunchPrompt("reviewPolicy") },
    ],
  });
});
