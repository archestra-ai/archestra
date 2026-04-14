import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  ToolHeader: ({ type }: { type: string }) => <div>{type}</div>,
  ToolInput: () => null,
  ToolOutput: () => null,
}));

vi.mock("@/components/chat/knowledge-graph-citations", () => ({
  hasKnowledgeBaseToolCall: () => false,
  KnowledgeGraphCitations: () => null,
}));

vi.mock("@/components/chat/message-actions", () => ({
  MessageActions: () => null,
}));

vi.mock("@/components/chat/policy-denied-tool", () => ({
  PolicyDeniedTool: () => null,
}));

vi.mock("@/components/divider", () => ({
  default: () => null,
}));

describe("MessageThread", () => {
  it("renders the swap-agent divider instead of the raw swap tool box", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-swap",
        role: "assistant",
        parts: [
          {
            type: "tool-spark_swap_agent",
            toolCallId: "swap-call",
            state: "output-available",
            input: { agent_name: "child agent" },
            output: { ok: true },
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getByText("Switched to child agent")).toBeInTheDocument();
    expect(screen.queryByText("tool-spark_swap_agent")).not.toBeInTheDocument();
  });

  it("renders the unsafe-context divider after the boundary tool result", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
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
    ];

    render(
      <MessageThread
        messages={messages}
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

  it("renders the preexisting unsafe-context divider for sensitive policy denials", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getByText("Sensitive context below")).toBeInTheDocument();
  });

  it("renders the unsafe-context divider before the first text after the boundary tool result", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_email",
            toolCallId: "call-unsafe",
            state: "output-available",
            input: { folder: "inbox" },
            output: { emails: [{ from: "ceo@external.com" }] },
          },
          {
            type: "text",
            text: "Done.",
          },
        ],
      },
    ];

    render(
      <MessageThread
        messages={messages}
        unsafeContextBoundary={{
          kind: "tool_result",
          reason: "tool_result_marked_untrusted",
          toolCallId: "call-unsafe",
          toolName: "read_email",
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

  it("matches persisted unsafe boundaries by tool name when tool call ids differ", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
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
    ];

    render(
      <MessageThread
        messages={messages}
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

  it("renders the sensitive-context divider only once after the thread becomes unsafe", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-1",
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
        id: "assistant-2",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\nI tried to invoke the internal-dev-test-server__print_archestra_test tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains sensitive data",
          },
        ],
      },
    ];

    render(
      <MessageThread
        messages={messages}
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
});
