import type { OpenAppaPolicyTargetKind } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { StrictMode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { SuggestedPrompt } from "@/app/chat/suggested-prompt-pills";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useConversation, useCreateConversation } from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { PolicyChatStarter } from "./policy-chat-starter";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("@/lib/chat/chat.query");
vi.mock("@/lib/chat/global-chat.context");
vi.mock("@/app/chat/prompt-input", () => ({
  default: ({
    onSubmit,
    fixedAgentName,
  }: {
    onSubmit: ({ text }: { text: string }) => void;
    fixedAgentName: string;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          text: (
            event.currentTarget.elements.namedItem(
              "policy",
            ) as HTMLTextAreaElement
          ).value,
        });
      }}
    >
      <span>{fixedAgentName}</span>
      <textarea
        name="policy"
        aria-label="Describe the OpenAPPA policy change"
      />
      <button type="submit">Start policy chat</button>
    </form>
  ),
}));
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: () => <div data-testid="policy-messages" />,
}));
vi.mock("@/lib/openappa-github-sync.query", () => ({
  useAppaGithubSync: vi.fn(),
}));
vi.mock("@/lib/llm-models.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-models.query")>()),
  useLlmModels: vi.fn(),
}));
vi.mock("@/lib/llm-provider-api-keys.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/llm-provider-api-keys.query")
  >()),
  useHasAnyApiKey: vi.fn(),
}));

const create = vi.fn();
const sendMessage = vi.fn();
const push = vi.fn();
const replace = vi.fn();
const renderStarter = (
  initialPrompt?: string,
  conversationId?: string,
  options?: {
    title?: string;
    subtitle?: string;
    suggestedPrompts?: readonly SuggestedPrompt[];
    policyTarget?: { kind: OpenAppaPolicyTargetKind; name: string };
  },
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PolicyChatStarter
        initialPrompt={initialPrompt}
        conversationId={conversationId}
        title={options?.title}
        subtitle={options?.subtitle}
        suggestedPrompts={options?.suggestedPrompts}
        policyTarget={options?.policyTarget}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace,
  } as unknown as ReturnType<typeof useRouter>);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  create.mockResolvedValue({
    id: "conversation-1",
    agentId: "policy-agent-1",
    messages: [],
  });
  vi.mocked(useCreateConversation).mockReturnValue({
    mutateAsync: create,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateConversation>);
  vi.mocked(useConversation).mockImplementation(
    (id) =>
      ({
        data: id ? { id, origin: "openappa", messages: [] } : undefined,
      }) as ReturnType<typeof useConversation>,
  );
  vi.mocked(useChatSession).mockImplementation(({ conversationId }) =>
    conversationId
      ? ({
          sendMessage,
          messages: [],
          status: "ready",
          optimisticToolCalls: [],
          setMessages: vi.fn(),
          addToolApprovalResponse: vi.fn(),
        } as unknown as ReturnType<typeof useChatSession>)
      : null,
  );
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: null },
  } as ReturnType<typeof useAppaGithubSync>);
  vi.mocked(useHasAnyApiKey).mockReturnValue({
    hasAnyApiKey: true,
    isLoading: false,
    isLoadError: false,
    refetch: vi.fn(),
  });
  vi.mocked(useLlmModels).mockReturnValue({
    data: [
      { dbId: "model-1", id: "model-1", provider: "openai", isBest: true },
    ],
    isPending: false,
    isError: false,
  } as ReturnType<typeof useLlmModels>);
});

test("opens a durable policy URL and sends the opening request after navigation", async () => {
  const view = renderStarter();
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "Require approval for outbound messages" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));

  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      origin: "openappa",
    }),
  );
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/openappa/conversation-1"),
  );
  view.unmount();
  renderStarter(undefined, "conversation-1");
  expect(screen.getByTestId("policy-messages")).toBeInTheDocument();
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      parts: [{ type: "text", text: "Require approval for outbound messages" }],
    }),
  );
});

test("starts a prompted configuration session when a model is available", async () => {
  const view = renderStarter("Review my policy before changing it");

  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/openappa/conversation-1"),
  );
  view.unmount();
  renderStarter(undefined, "conversation-1");
  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      origin: "openappa",
    }),
  );
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: "text", text: "Review my policy before changing it" }],
      }),
    ),
  );
  expect(create).toHaveBeenCalledTimes(1);
});

test("does not start a prompted session before a provider key is available", () => {
  vi.mocked(useHasAnyApiKey).mockReturnValue({
    hasAnyApiKey: false,
    isLoading: false,
    isLoadError: false,
    refetch: vi.fn(),
  });
  renderStarter("Review my policy before changing it");
  expect(create).not.toHaveBeenCalled();
});

test("starts with a policy-specific suggested prompt", async () => {
  const view = renderStarter();
  fireEvent.click(
    screen.getByRole("button", { name: "Explain my current policy" }),
  );
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/openappa/conversation-1"),
  );
  view.unmount();
  renderStarter(undefined, "conversation-1");
  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      origin: "openappa",
    }),
  );
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("Do not change it"),
          }),
        ],
      }),
    ),
  );
});

test("shows a target-scoped title, subtitle, and suggested prompts on the welcome screen", async () => {
  const view = renderStarter(undefined, undefined, {
    title: "What should the policy do for Research assistant?",
    subtitle: 'Describe a change for the agent "Research assistant".',
    suggestedPrompts: [
      {
        summaryTitle: "Explain the policy for Research assistant",
        prompt: "Explain the policy for the agent Research assistant.",
      },
    ],
    policyTarget: { kind: "agent", name: "Research assistant" },
  });
  expect(
    screen.getByText("What should the policy do for Research assistant?"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Describe a change for the agent "Research assistant"/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("What should the policy do?"),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Explain the policy for Research assistant",
    }),
  );
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/openappa/conversation-1?targetType=agent&targetName=Research%20assistant",
    ),
  );
  view.unmount();
  renderStarter(undefined, "conversation-1");
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          {
            type: "text",
            text: "Explain the policy for the agent Research assistant.",
          },
        ],
      }),
    ),
  );
});

test("does not auto-send when a conversation is scoped to a policy target", () => {
  renderStarter(undefined, undefined, {
    title: "What should the policy do for Research assistant?",
    policyTarget: { kind: "agent", name: "Research assistant" },
  });
  // The target flow never passes an initial prompt, so the auto-send effect
  // (gated on `initialPrompt`) must not fire: the user lands on the welcome
  // screen with nothing sent, not mid-conversation.
  expect(create).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

test("attaches the scoped policy target as hidden metadata on the opening message", async () => {
  const view = renderStarter(undefined, undefined, {
    policyTarget: { kind: "mcp_server", name: "GitHub" },
  });
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "What can this server do?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/openappa/conversation-1?targetType=mcp_server&targetName=GitHub",
    ),
  );
  view.unmount();
  // The opening message goes through the create → handoff → sendMessage
  // round-trip, so the metadata must survive that hop.
  renderStarter(undefined, "conversation-1", {
    policyTarget: { kind: "mcp_server", name: "GitHub" },
  });
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: "text", text: "What can this server do?" }],
        metadata: expect.objectContaining({
          openAppaPolicyTarget: { kind: "mcp_server", name: "GitHub" },
        }),
      }),
    ),
  );
});

test("carries the policy target through the create-and-redirect navigation URL", async () => {
  renderStarter(undefined, undefined, {
    policyTarget: { kind: "mcp_server", name: "GitHub" },
  });
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "What can this server do?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  // `/openappa/[conversationId]` remounts this component from scratch with no
  // policyTarget prop of its own, so the target must ride in the URL the
  // redirect navigates to (resolved back into a prop by the page's own
  // `resolveOpenAppaPolicyTarget` call) or the scope is silently dropped for
  // the deferred opening message and every follow-up on that conversation.
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/openappa/conversation-1?targetType=mcp_server&targetName=GitHub",
    ),
  );
});

test("omits the target query params when redirecting an unscoped conversation", async () => {
  renderStarter();
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "Require approval for outbound messages" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/openappa/conversation-1"),
  );
});

test("attaches the scoped policy target to every follow-up message", () => {
  renderStarter(undefined, "conversation-1", {
    policyTarget: { kind: "mcp_server", name: "GitHub" },
  });
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "And now?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      parts: [{ type: "text", text: "And now?" }],
      metadata: expect.objectContaining({
        openAppaPolicyTarget: { kind: "mcp_server", name: "GitHub" },
      }),
    }),
  );
});

test("omits policy-target metadata for an unscoped conversation", () => {
  renderStarter(undefined, "conversation-1");
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "General question" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      parts: [{ type: "text", text: "General question" }],
    }),
  );
  const [sent] = sendMessage.mock.calls.at(-1) ?? [];
  expect(sent.metadata).not.toHaveProperty("openAppaPolicyTarget");
});

test("loads an existing policy conversation without creating or resending it", () => {
  renderStarter(undefined, "conversation-1");
  expect(screen.getByTestId("policy-messages")).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("back and forward navigation does not create or resend a policy conversation", async () => {
  const configure = renderStarter();
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "Explain my current policy" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/openappa/conversation-1"),
  );
  configure.unmount();

  const firstVisit = renderStarter(undefined, "conversation-1");
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  firstVisit.unmount();

  const back = renderStarter();
  expect(screen.getByText("What should the policy do?")).toBeInTheDocument();
  back.unmount();

  renderStarter(undefined, "conversation-1");
  expect(screen.getByTestId("policy-messages")).toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

test("sends the handed-off request once under StrictMode effect replay", async () => {
  setPendingProjectChatHandoff({
    conversationId: "conversation-1",
    prompt: "Explain the policy",
  });
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <PolicyChatStarter conversationId="conversation-1" />
      </QueryClientProvider>
    </StrictMode>,
  );
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      parts: [{ type: "text", text: "Explain the policy" }],
    }),
  );
});

test("redirects a non-policy conversation to its chat route", () => {
  vi.mocked(useConversation).mockReturnValue({
    data: { id: "conversation-1", origin: "user", messages: [] },
  } as unknown as ReturnType<typeof useConversation>);
  renderStarter(undefined, "conversation-1");
  expect(replace).toHaveBeenCalledWith("/chat/conversation-1");
  expect(sendMessage).not.toHaveBeenCalled();
});

test("offers provider setup when no chat credential is available", () => {
  vi.mocked(useHasAnyApiKey).mockReturnValue({
    hasAnyApiKey: false,
    isLoading: false,
    isLoadError: false,
    refetch: vi.fn(),
  });

  renderStarter();
  expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
  expect(
    screen.queryByText("What should the policy do?"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
  ).not.toBeInTheDocument();
});

test("explains that synced changes become pull requests", () => {
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: { interval: "1h", githubAppConfigId: "app-1" } },
  } as ReturnType<typeof useAppaGithubSync>);

  renderStarter();
  expect(screen.getByText(/opens a GitHub pull request/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Start policy chat" }),
  ).toBeEnabled();
});

test("asks for a GitHub App before proposing changes to a synced policy", () => {
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: { interval: "1h", githubAppConfigId: null } },
  } as ReturnType<typeof useAppaGithubSync>);

  renderStarter();
  expect(screen.getByText("GitHub App needed")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Start policy chat" }),
  ).toBeEnabled();
});
