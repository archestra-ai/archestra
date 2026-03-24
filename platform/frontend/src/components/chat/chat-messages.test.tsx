import type { UIMessage } from "@ai-sdk/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));

vi.mock("@/components/ai-elements/message", () => ({
  Message: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MessageContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/reasoning", () => ({
  Reasoning: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ReasoningContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ReasoningTrigger: () => null,
}));

vi.mock("@/components/ai-elements/response", () => ({
  Response: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/tool", () => ({
  Tool: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToolContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToolHeader: ({ type }: { type: string }) => <div>{type}</div>,
  ToolInput: ({ input }: { input: unknown }) => (
    <pre>{JSON.stringify(input)}</pre>
  ),
  ToolOutput: ({ output }: { output: unknown }) => (
    <pre>{JSON.stringify(output)}</pre>
  ),
  ToolErrorDetails: ({ errorText }: { errorText: string }) => (
    <div>{errorText}</div>
  ),
}));

vi.mock("@/components/chat/editable-assistant-message", () => ({
  EditableAssistantMessage: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("@/components/chat/editable-user-message", () => ({
  EditableUserMessage: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("@/components/chat/inline-chat-error", () => ({
  InlineChatError: () => null,
}));

vi.mock("@/components/chat/mcp-install-dialogs", () => ({
  McpInstallDialogs: () => null,
}));

vi.mock("@/components/chat/policy-denied-tool", () => ({
  PolicyDeniedTool: () => null,
}));

vi.mock("@/components/chat/auth-required-tool", () => ({
  AuthRequiredTool: () => null,
}));

vi.mock("@/components/chat/expired-auth-tool", () => ({
  ExpiredAuthTool: () => null,
}));

vi.mock("@/components/chat/todo-write-tool", () => ({
  TodoWriteTool: () => <div>todo-write-tool</div>,
}));

vi.mock("@/components/chat/tool-error-logs-button", () => ({
  ToolErrorLogsButton: () => null,
}));

vi.mock("@/components/chat/tool-status-row", () => ({
  ToolStatusRow: () => null,
}));

vi.mock("@/components/chat/knowledge-graph-citations", () => ({
  hasKnowledgeBaseToolCall: () => false,
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useSession: () => ({ data: { user: { name: "Joey" } } }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useProfileToolsWithIds: () => ({ data: [] }),
}));

vi.mock("@/lib/chat/chat-message.query", () => ({
  useUpdateChatMessage: () => ({
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => ({ data: [] }),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: () => ({
    triggerInstallByCatalogId: vi.fn(),
    triggerReauthByCatalogIdAndServerId: vi.fn(),
  }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({ data: null }),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppIconLogo: () => "/custom-logo.png",
}));

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({
    getToolName: (shortName: string) => `sparky__${shortName}`,
    getToolShortName: (toolName: string) =>
      toolName.startsWith("sparky__") ? toolName.replace("sparky__", "") : null,
    isToolName: (toolName: string) => toolName.startsWith("sparky__"),
  }),
}));

import { ChatMessages } from "./chat-messages";

describe("ChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the swap divider for branded built-in swap tools", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "call-1",
            state: "output-available",
            input: { agent_name: "GitHub Agent" },
            output: { ok: true },
          },
        ],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(screen.getByText("Switched to GitHub Agent")).toBeInTheDocument();
  });

  it("keeps an expanded compact tool panel open when later tool calls append to the same message", () => {
    const initialMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-github__list_issues",
            toolCallId: "call-1",
            state: "input-available",
            input: { owner: "a", repo: "b" },
          },
          {
            type: "tool-github__list_issues",
            toolCallId: "call-1",
            state: "output-available",
            output: { issue: 1 },
          },
          {
            type: "tool-github__list_pull_requests",
            toolCallId: "call-2",
            state: "input-available",
            input: { owner: "a", repo: "b" },
          },
          {
            type: "tool-github__list_pull_requests",
            toolCallId: "call-2",
            state: "output-available",
            output: { pr: 2 },
          },
        ],
      },
    ] as UIMessage[];

    const { rerender } = render(
      <ChatMessages
        conversationId="conv-1"
        messages={initialMessages}
        status="ready"
      />,
    );

    const toolButtons = screen.getAllByRole("button");
    fireEvent.click(toolButtons[0]);
    expect(screen.getByText('{"issue":1}')).toBeInTheDocument();

    const updatedMessages = [
      {
        ...initialMessages[0],
        parts: [
          ...initialMessages[0].parts,
          {
            type: "tool-github__get_issue",
            toolCallId: "call-3",
            state: "input-available",
            input: { owner: "a", repo: "b", issue_number: 1 },
          },
          {
            type: "tool-github__get_issue",
            toolCallId: "call-3",
            state: "output-available",
            output: { issue: 3 },
          },
        ],
      },
    ] as UIMessage[];

    rerender(
      <ChatMessages
        conversationId="conv-1"
        messages={updatedMessages}
        status="ready"
      />,
    );

    expect(screen.getByText('{"issue":1}')).toBeInTheDocument();
  });

  it("renders branded built-in todo_write with the specialized todo tool UI", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-sparky__todo_write",
            toolCallId: "call-1",
            state: "output-available",
            input: {
              todos: [{ content: "Find GitHub tools", status: "completed" }],
            },
            output: { ok: true },
          },
        ],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(screen.getByText("todo-write-tool")).toBeInTheDocument();
    expect(
      screen.queryByText("tool-sparky__todo_write"),
    ).not.toBeInTheDocument();
  });
});
