import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useConversation,
  useCreateConversation,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { PolicyChatStarter } from "./policy-chat-starter";

vi.mock("@/lib/auth/auth.query");
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
const renderStarter = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PolicyChatStarter />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(useUpdateConversation).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateConversation>);
  vi.mocked(useConversation).mockImplementation(
    (id) =>
      ({
        data: id ? { id, messages: [] } : undefined,
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

test("starts a policy conversation on this page and sends the user's request", async () => {
  renderStarter();
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "Require approval for outbound messages" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));

  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      modelId: "model-1",
      origin: "openappa",
    }),
  );
  await vi.waitFor(() =>
    expect(screen.getByTestId("policy-messages")).toBeInTheDocument(),
  );
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      parts: [{ type: "text", text: "Require approval for outbound messages" }],
    }),
  );
});

test("starts with a policy-specific suggested prompt", async () => {
  renderStarter();
  fireEvent.click(
    screen.getByRole("button", { name: "Explain my current policy" }),
  );
  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      modelId: "model-1",
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
