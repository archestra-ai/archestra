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

    expect(
      screen.getByText("Sensitive context starts here"),
    ).toBeInTheDocument();
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

    expect(
      screen.getByText(
        "Sensitive context was already active when this request started",
      ),
    ).toBeInTheDocument();
  });
});
