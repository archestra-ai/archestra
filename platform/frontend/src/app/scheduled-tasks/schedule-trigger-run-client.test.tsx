import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleTriggerRunPage } from "./schedule-trigger-run-client";

const { fetchPreferredLlmModelForApiKeyMock, updateConversationMutateMock } =
  vi.hoisted(() => ({
    fetchPreferredLlmModelForApiKeyMock: vi.fn(),
    updateConversationMutateMock: vi.fn(),
  }));

vi.mock("@/app/chat/prompt-input", () => ({
  default: ({
    onProviderChange,
  }: {
    onProviderChange: (provider: "openai" | "anthropic", keyId: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onProviderChange("openai", "key-a")}>
        Select key A
      </button>
      <button
        type="button"
        onClick={() => onProviderChange("anthropic", "key-b")}
      >
        Select key B
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: () => <div>Messages</div>,
}));

vi.mock("@/components/chat/conversation-artifact", () => ({
  ConversationArtifactPanel: () => null,
}));

vi.mock("@/components/loading", () => ({
  LoadingSpinner: () => <span>Loading</span>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/lib/agent.query", () => ({
  useInternalAgents: () => ({ data: [] }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useConversation: () => ({
    data: {
      id: "conv-1",
      agentId: "agent-1",
      agent: { id: "agent-1", name: "Agent", llmApiKeyId: null },
      chatApiKeyId: "key-initial",
      selectedModel: "gpt-4.1",
      messages: [],
    },
    isLoading: false,
  }),
  useStopChatStream: () => ({ mutateAsync: vi.fn() }),
  useUpdateConversation: () => ({ mutate: updateConversationMutateMock }),
}));

vi.mock("@/lib/chat/global-chat.context", () => ({
  useChatSession: () => ({
    messages: [],
    status: "ready",
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    optimisticToolCalls: [],
    addToolApprovalResponse: vi.fn(),
  }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  fetchPreferredLlmModelForApiKey: fetchPreferredLlmModelForApiKeyMock,
  useAvailableLlmModel: () => ({
    data: {
      id: "gpt-4.1",
      provider: "openai",
      capabilities: {
        contextLength: 128000,
        inputModalities: ["text"],
      },
    },
  }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({ data: { allowChatFileUploads: false } }),
}));

vi.mock("@/lib/schedule-trigger.query", () => ({
  useCreateScheduleTriggerRunConversation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useScheduleTrigger: () => ({
    data: {
      id: "trigger-1",
      agentId: "agent-1",
      agent: { name: "Agent" },
      timezone: "UTC",
      cron: "* * * * *",
    },
    isLoading: false,
  }),
  useScheduleTriggerRun: () => ({
    data: {
      id: "run-1",
      status: "completed",
      chatConversationId: "conv-1",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    },
    isLoading: false,
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/utils/date-time", () => ({
  formatRelativeTimeFromNow: () => "just now",
}));

vi.mock("@/lib/utils/format-cron", () => ({
  formatCronSchedule: () => "Every minute",
}));

describe("ScheduleTriggerRunPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    };
  });

  it("ignores stale preferred-model lookups when provider changes race", async () => {
    const user = userEvent.setup();
    let resolveA: (value: unknown) => void = () => {};
    let resolveB: (value: unknown) => void = () => {};
    fetchPreferredLlmModelForApiKeyMock.mockImplementation(
      ({ apiKeyId }: { apiKeyId: string }) =>
        new Promise((resolve) => {
          if (apiKeyId === "key-a") {
            resolveA = resolve;
          } else {
            resolveB = resolve;
          }
        }),
    );

    render(<ScheduleTriggerRunPage triggerId="trigger-1" runId="run-1" />);

    await user.click(screen.getByRole("button", { name: "Select key A" }));
    await user.click(screen.getByRole("button", { name: "Select key B" }));

    await act(async () => {
      resolveB({ id: "claude-3-5-sonnet", provider: "anthropic" });
    });

    await waitFor(() => {
      expect(updateConversationMutateMock).toHaveBeenCalledWith({
        id: "conv-1",
        chatApiKeyId: "key-b",
        modelId: "claude-3-5-sonnet",
      });
    });

    await act(async () => {
      resolveA({ id: "gpt-4.1", provider: "openai" });
    });

    expect(updateConversationMutateMock).toHaveBeenCalledOnce();
  });
});
