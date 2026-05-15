import type { UIMessage } from "@ai-sdk/react";
import { SWAP_AGENT_POKE_TEXT } from "@shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    children: React.ReactNode;
  }) => (
    <div data-testid="conversation" {...props}>
      {children}
    </div>
  ),
  ConversationContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
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
  InlineChatError: ({ error }: { error: Error }) => (
    <div data-testid="inline-chat-error">{error.message}</div>
  ),
}));

vi.mock("@/components/chat/mcp-install-dialogs", () => ({
  McpInstallDialogs: () => null,
}));

vi.mock("@/components/chat/policy-denied-tool", () => ({
  PolicyDeniedTool: () => null,
}));

vi.mock("@/components/chat/auth-required-tool", () => ({
  AuthRequiredTool: ({
    catalogName,
    onInstall,
  }: {
    catalogName: string;
    onInstall?: () => void;
  }) => (
    <button type="button" onClick={onInstall}>
      auth-required:{catalogName}
    </button>
  ),
}));

vi.mock("@/components/chat/assigned-credential-unavailable-tool", () => ({
  AssignedCredentialUnavailableTool: ({
    catalogName,
  }: {
    catalogName: string;
  }) => <div>assigned-credential-unavailable:{catalogName}</div>,
}));

vi.mock("@/components/chat/expired-auth-tool", () => ({
  ExpiredAuthTool: ({
    catalogName,
    onReauth,
  }: {
    catalogName: string;
    onReauth?: () => void;
  }) => (
    <button type="button" onClick={onReauth}>
      expired-auth:{catalogName}
    </button>
  ),
}));

vi.mock("@/components/chat/todo-write-tool", () => ({
  TodoWriteTool: () => <div>todo-write-tool</div>,
}));

vi.mock("@/components/chat/mcp-app-container", () => ({
  McpAppSection: () => null,
  McpToolOutput: null,
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

vi.mock("@/lib/chat/global-chat.context", () => ({
  useGlobalChat: () => ({
    getSession: () => null,
  }),
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
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("moves focus between messages with shift arrow navigation", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First user message" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "First assistant message" }],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Second user message" }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    const firstMessage = screen.getByLabelText("Message 1 of 3");
    const secondMessage = screen.getByLabelText("Message 2 of 3");
    const thirdMessage = screen.getByLabelText("Message 3 of 3");

    firstMessage.focus();
    fireEvent.keyDown(firstMessage, { key: "ArrowDown", shiftKey: true });
    expect(secondMessage).toHaveFocus();

    fireEvent.keyDown(secondMessage, { key: "ArrowDown", shiftKey: true });
    expect(thirdMessage).toHaveFocus();

    fireEvent.keyDown(thirdMessage, { key: "ArrowUp", shiftKey: true });
    expect(secondMessage).toHaveFocus();
  });

  it("returns focus to the prompt textarea from the last message with shift arrow down", () => {
    const promptTextarea = document.createElement("textarea");
    document.body.appendChild(promptTextarea);
    const promptTextareaRef = { current: promptTextarea };

    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First user message" }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        promptTextareaRef={promptTextareaRef}
      />,
    );

    const message = screen.getByLabelText("Message 1 of 1");
    message.focus();
    fireEvent.keyDown(message, { key: "ArrowDown", shiftKey: true });

    expect(promptTextarea).toHaveFocus();
    promptTextarea.remove();
  });

  it("does not include hidden swap poke messages in keyboard navigation", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Visible user message" }],
      },
      {
        id: "swap-poke",
        role: "user",
        parts: [{ type: "text", text: SWAP_AGENT_POKE_TEXT }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Visible assistant message" }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(screen.getByLabelText("Message 1 of 2")).toHaveTextContent(
      "Visible user message",
    );
    expect(screen.getByLabelText("Message 2 of 2")).toHaveTextContent(
      "Visible assistant message",
    );
    expect(screen.queryByText(SWAP_AGENT_POKE_TEXT)).not.toBeInTheDocument();
  });

  it("renders URL and document source parts for assistant messages", () => {
    const messages = [
      {
        id: "assistant-sources",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "The incident report matches the deployment window.",
          },
          {
            type: "source-url",
            sourceId: "source-runbook",
            url: "https://example.test/runbooks/deployments",
            title: "Deployment Runbook",
          },
          {
            type: "source-document",
            sourceId: "source-pdf",
            mediaType: "application/pdf",
            title: "Incident Review Packet",
            filename: "incident-review.pdf",
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

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Deployment Runbook/i }),
    ).toHaveAttribute("href", "https://example.test/runbooks/deployments");
    expect(screen.getByText("Incident Review Packet")).toBeInTheDocument();
    expect(screen.getByText("incident-review.pdf")).toBeInTheDocument();
  });

  it("deduplicates repeated source parts by source id", () => {
    const messages = [
      {
        id: "assistant-duplicate-sources",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "I found one authoritative source.",
          },
          {
            type: "source-url",
            sourceId: "source-release-notes",
            url: "https://example.test/releases/2026-04",
            title: "April Release Notes",
          },
          {
            type: "source-url",
            sourceId: "source-release-notes",
            url: "https://example.test/releases/2026-04?duplicate=true",
            title: "April Release Notes Duplicate",
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

    expect(
      screen.getAllByRole("link", { name: /April Release Notes/i }),
    ).toHaveLength(1);
    expect(
      screen.queryByText("April Release Notes Duplicate"),
    ).not.toBeInTheDocument();
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

  it("deduplicates adjacent swap dividers for the same target", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "call-1",
            state: "input-available",
            input: { agent_name: "Jira Agent" },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "call-1",
            state: "output-available",
            input: { agent_name: "Jira Agent" },
            output: { ok: true },
          },
        ],
      },
      {
        id: "assistant-3",
        role: "assistant",
        parts: [{ type: "text", text: "I am the Jira Agent." }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(screen.getAllByText("Switched to Jira Agent")).toHaveLength(1);
  });

  it("renders failed swap tools as compact error indicators instead of swap dividers", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-sparky__swap_agent",
            toolCallId: "call-1",
            state: "output-available",
            input: { agent_name: "Jira Agent" },
            output: JSON.stringify({
              success: false,
              code: "already_using_agent",
              message:
                'Already using agent "Jira Agent". Choose a different agent.',
              archestraError: {
                type: "tool_state",
                code: "already_using_agent",
                message:
                  'Already using agent "Jira Agent". Choose a different agent.',
                toolName: "swap_agent",
              },
            }),
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

    const toolButtons = screen.getAllByRole("button");
    expect(toolButtons).toHaveLength(1);
    expect(
      screen.queryByText("tool-sparky__swap_agent"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Switched to Jira Agent"),
    ).not.toBeInTheDocument();

    fireEvent.click(toolButtons[0]);
    expect(screen.getByText("tool-sparky__swap_agent")).toBeInTheDocument();
  });

  it("renders persisted chat errors between messages by timestamp", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        metadata: { createdAt: "2026-04-22T12:00:00.000Z" },
        parts: [{ type: "text", text: "first try" }],
      },
      {
        id: "user-2",
        role: "user",
        metadata: { createdAt: "2026-04-22T12:02:00.000Z" },
        parts: [{ type: "text", text: "try again" }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        chatErrors={[
          {
            id: "error-1",
            conversationId: "conv-1",
            createdAt: "2026-04-22T12:01:00.000Z",
            error: {
              code: "server_error",
              message: "Provider failed",
              isRetryable: true,
            },
          },
        ]}
      />,
    );

    const firstTry = screen.getByText("first try");
    const error = screen.getByTestId("inline-chat-error");
    const retry = screen.getByText("try again");

    expect(firstTry.compareDocumentPosition(error)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(error.compareDocumentPosition(retry)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("does not render persisted chat errors before live messages without timestamps", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "live retry" }],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        chatErrors={[
          {
            id: "error-1",
            conversationId: "conv-1",
            createdAt: "2026-04-22T12:01:00.000Z",
            error: {
              code: "server_error",
              message: "Provider failed",
              isRetryable: true,
            },
          },
        ]}
      />,
    );

    const retry = screen.getByText("live retry");
    const error = screen.getByTestId("inline-chat-error");

    expect(retry.compareDocumentPosition(error)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders the unsafe-context divider when a tool result marks the context unsafe", () => {
    const messages = [
      {
        id: "assistant-unsafe",
        role: "assistant",
        parts: [
          {
            type: "tool-read_email",
            toolCallId: "call-unsafe",
            state: "output-available",
            input: { folder: "inbox" },
            output: { emails: [{ from: "ceo@external.com" }] },
          },
        ],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        unsafeContextBoundary={{
          kind: "tool_result",
          reason: "tool_result_marked_untrusted",
          toolCallId: "call-unsafe",
          toolName: "read_email",
        }}
      />,
    );

    expect(screen.getByText("Sensitive context below")).toBeInTheDocument();
  });

  it("renders the unsafe-context divider immediately after the unsafe tool result within the same message", () => {
    const messages = [
      {
        id: "assistant-live-unsafe",
        role: "assistant",
        parts: [
          {
            type: "tool-read_email",
            toolCallId: "call-live-unsafe",
            state: "output-available",
            input: { folder: "inbox" },
            output: {
              content: "ARCH_TEST = secret-value",
              unsafeContextBoundary: {
                kind: "tool_result",
                reason: "tool_result_marked_untrusted",
                toolCallId: "call-live-unsafe",
                toolName: "read_email",
              },
            },
          },
          {
            type: "text",
            text: "Done.",
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

    const divider = screen.getByText("Sensitive context below");
    const assistantText = screen.getByText("Done.");

    expect(divider).toBeInTheDocument();
    expect(
      divider.compareDocumentPosition(assistantText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("matches persisted unsafe boundaries by tool name when tool call ids differ", () => {
    const messages = [
      {
        id: "assistant-persisted-unsafe",
        role: "assistant",
        parts: [
          {
            type: "tool-internal-dev-test-server__print_archestra_test",
            toolCallId: "ai-sdk-tool-call-id",
            state: "output-available",
            input: {},
            output: { content: "ARCHESTRA_TEST = asdfasdfadsf" },
          },
          {
            type: "text",
            text: "Done.",
          },
        ],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        unsafeContextBoundary={{
          kind: "tool_result",
          reason: "tool_result_marked_untrusted",
          toolCallId: "mcp-tool-call-id",
          toolName: "internal-dev-test-server__print_archestra_test",
        }}
      />,
    );

    const divider = screen.getByText("Sensitive context below");
    const assistantText = screen.getByText("Done.");

    expect(
      divider.compareDocumentPosition(assistantText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the preexisting unsafe-context divider when the request starts unsafe", () => {
    render(
      <ChatMessages
        conversationId="conv-1"
        messages={
          [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [{ type: "text", text: "Continuing the workflow." }],
            },
          ] as UIMessage[]
        }
        status="ready"
        unsafeContextBoundary={{
          kind: "preexisting_untrusted",
          reason: "inherited_from_parent",
        }}
      />,
    );

    expect(screen.getByText("Sensitive context below")).toBeInTheDocument();
  });

  it("renders the preexisting unsafe-context divider for policy-denied text caused by sensitive context", () => {
    const messages = [
      {
        id: "assistant-denied",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
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

    expect(screen.getByText("Sensitive context below")).toBeInTheDocument();
  });

  it("infers the sensitive-context boundary before the first assistant text after an unsafe tool result", () => {
    const messages = [
      {
        id: "assistant-sensitive",
        role: "assistant",
        parts: [
          {
            type: "tool-internal-dev-test-server__print_archestra_test",
            toolCallId: "call-1",
            state: "output-available",
            output: "ARCHESTRA_TEST = asdfasdfadsf",
          },
          {
            type: "text",
            text: "Done.",
          },
        ],
      },
      {
        id: "assistant-denied",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
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

    const dividers = screen.getAllByText("Sensitive context below");
    const firstDivider = dividers[0];
    const assistantText = screen.getByText("Done.");

    expect(dividers).toHaveLength(1);
    expect(
      firstDivider.compareDocumentPosition(assistantText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the sensitive-context divider only once after the thread becomes unsafe", () => {
    const messages = [
      {
        id: "assistant-sensitive",
        role: "assistant",
        parts: [
          {
            type: "tool-internal-dev-test-server__print_archestra_test",
            toolCallId: "ai-sdk-tool-call-id",
            state: "output-available",
            input: {},
            output: { content: "ARCHESTRA_TEST = asdfasdfadsf" },
          },
          {
            type: "text",
            text: '"ARCHESTRA_TEST = asdfasdfadsf"',
          },
        ],
      },
      {
        id: "assistant-denied",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ],
      },
    ] as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
        unsafeContextBoundary={{
          kind: "tool_result",
          reason: "tool_result_marked_untrusted",
          toolCallId: "mcp-tool-call-id",
          toolName: "internal-dev-test-server__print_archestra_test",
        }}
      />,
    );

    expect(screen.getAllByText("Sensitive context below")).toHaveLength(1);
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

  it("does not render branded built-in todo_write in the message timeline", () => {
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

    expect(screen.queryByText("todo-write-tool")).not.toBeInTheDocument();
    expect(
      screen.queryByText("tool-sparky__todo_write"),
    ).not.toBeInTheDocument();
  });

  it("renders assistant expired-auth text as the inline reauth tool UI", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: 'Expired or invalid authentication for "id-jag test".\n\nYour credentials (user: usr_123) failed authentication. Please re-authenticate to continue using this tool.\nTo re-authenticate, visit this URL: http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz',
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

    expect(
      screen.getByRole("button", { name: "expired-auth:id-jag test" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/To re-authenticate, visit this URL:/),
    ).not.toBeInTheDocument();
  });

  it("renders assistant auth-required text as the inline install tool UI", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: 'Authentication required for "jwks demo".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_abc',
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

    expect(
      screen.getByRole("button", { name: "auth-required:jwks demo" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/To set up your credentials, visit this URL:/),
    ).not.toBeInTheDocument();
  });

  it("renders structured auth-expired tool output as the inline reauth tool UI", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-id-jag_test__get_server_info",
            toolCallId: "call-1",
            state: "output-available",
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "auth_expired",
                  message:
                    'Expired or invalid authentication for "id-jag test".',
                  catalogId: "cat_abc",
                  catalogName: "id-jag test",
                  serverId: "srv_xyz",
                  reauthUrl:
                    "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
                },
              },
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(
      screen.getByRole("button", { name: "expired-auth:id-jag test" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("tool-id-jag_test__get_server_info"),
    ).not.toBeInTheDocument();
  });

  it("renders structured assigned-credential-unavailable tool output as config error UI", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-githubcopilot__remote-mcp__issue_write",
            toolCallId: "call-1",
            state: "output-available",
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "assigned_credential_unavailable",
                  message: "Assigned credential unavailable",
                  catalogId: "cat_abc",
                  catalogName: "githubcopilot__remote-mcp",
                },
              },
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(
      screen.getByText(
        "assigned-credential-unavailable:githubcopilot__remote-mcp",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("tool-githubcopilot__remote-mcp__issue_write"),
    ).not.toBeInTheDocument();
  });

  it("suppresses duplicate assistant auth text when the same message already has a tool auth error", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-id-jag_test__get_server_info",
            toolCallId: "call-1",
            state: "output-available",
            output: {
              isError: true,
              _meta: {
                archestraError: {
                  type: "auth_expired",
                  message:
                    'Expired or invalid authentication for "id-jag test".',
                  catalogId: "cat_abc",
                  catalogName: "id-jag test",
                  serverId: "srv_xyz",
                  reauthUrl:
                    "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
                },
              },
            },
          },
          {
            type: "text",
            text: 'Your authentication for "id-jag test" is expired or invalid. Please re-authenticate by visiting this URL: http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz',
          },
        ],
      },
    ] as unknown as UIMessage[];

    render(
      <ChatMessages
        conversationId="conv-1"
        messages={messages}
        status="ready"
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "expired-auth:id-jag test" }),
    ).toHaveLength(1);
    expect(
      screen.queryByText(/Please re-authenticate by visiting this URL/i),
    ).not.toBeInTheDocument();
  });
});
