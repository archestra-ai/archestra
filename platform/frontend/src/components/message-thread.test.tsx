import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/lib/organization.query";
import MessageThread, { type PartialUIMessage } from "./message-thread";

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));

vi.mock("@/components/ai-elements/loader", () => ({
  Loader: () => null,
}));

vi.mock("@/components/ai-elements/message", () => ({
  Message: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="message-bubble">{children}</div>
  ),
  MessageContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/reasoning", () => ({
  Reasoning: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="reasoning">{children}</div>
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

vi.mock("@/components/ai-elements/sources", () => ({
  Source: () => null,
  Sources: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SourcesContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SourcesTrigger: () => null,
}));

vi.mock("@/components/ai-elements/tool", () => ({
  Tool: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToolContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToolHeader: ({ type, state }: { type: string; state?: string }) => (
    <div>
      {type}
      {state ? <span data-testid="tool-state">{state}</span> : null}
    </div>
  ),
  ToolInput: () => null,
  ToolOutput: ({ label }: { label?: string }) =>
    label ? <div data-testid="tool-output-label">{label}</div> : null,
}));

vi.mock("@/components/chat/knowledge-graph-citations", () => ({
  hasKnowledgeBaseToolCall: () => false,
  KnowledgeGraphCitations: () => null,
}));

vi.mock("@/components/chat/inline-chat-error", () => ({
  InlineChatError: ({ error }: { error: Error }) => {
    const parsed = JSON.parse(error.message);
    return <div data-testid="inline-chat-error">{parsed.message}</div>;
  },
}));

vi.mock("@/components/chat/message-actions", () => ({
  MessageActions: () => null,
}));

vi.mock("@/components/divider", () => ({
  default: () => null,
}));

vi.mock("@/lib/organization.query");

beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
});

describe("MessageThread", () => {
  it("renders a cancelled tool call as Cancelled, not Success or Error", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "slow_report",
            toolCallId: "call-cancelled",
            state: "output-available",
            input: { seconds: 90 },
            // The structured envelope the backend serializes when the user
            // stops a run or cancels a background task mid-call.
            output: {
              archestraError: {
                type: "cancelled",
                message: "The user cancelled this call before it finished.",
              },
            },
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    // Header state and output label both read cancelled — a user-initiated
    // stop is neither a success nor a failure.
    expect(screen.getByTestId("tool-state")).toHaveTextContent(
      "output-cancelled",
    );
    expect(screen.getByTestId("tool-output-label")).toHaveTextContent(
      "Cancelled",
    );
  });

  it("does not render a message bubble for whitespace-only text parts", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: " " },
          {
            type: "dynamic-tool",
            toolName: "search_tools",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: { ok: true },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "All done." }],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getAllByTestId("message-bubble")).toHaveLength(1);
    expect(screen.getByText("All done.")).toBeInTheDocument();
  });

  it("does not render an accordion for empty reasoning parts", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "" },
          { type: "reasoning", text: "  " },
          { type: "reasoning", text: "actual reasoning" },
          { type: "text", text: "the answer" },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getAllByTestId("reasoning")).toHaveLength(1);
    expect(screen.getByText("actual reasoning")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
  });

  it("renders persisted chat errors between messages by timestamp", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "user-1",
        role: "user",
        metadata: {
          createdAt: "2026-04-22T12:00:00.000Z",
        } as PartialUIMessage["metadata"],
        parts: [{ type: "text", text: "first try" }],
      },
      {
        id: "user-2",
        role: "user",
        metadata: {
          createdAt: "2026-04-22T12:02:00.000Z",
        } as PartialUIMessage["metadata"],
        parts: [{ type: "text", text: "try again" }],
      },
    ];

    render(
      <MessageThread
        messages={messages}
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
});
