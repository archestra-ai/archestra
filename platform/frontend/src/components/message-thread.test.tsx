import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageThread, { type PartialUIMessage } from "./message-thread";

vi.mock("@/components/ai-elements/conversation", () => {
  const Conversation = Object.assign(
    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    {
      Content: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
      ),
      ScrollButton: () => null,
    },
  );

  return { Conversation };
});

vi.mock("@/components/ai-elements/loader", () => ({
  Loader: () => null,
}));

vi.mock("@/components/ai-elements/message", () => {
  const Message = Object.assign(
    ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    {
      Content: ({
        children,
        variant,
      }: {
        children: React.ReactNode;
        variant?: string;
      }) => (
        <div data-message-content-variant={variant ?? "contained"}>
          {children}
        </div>
      ),
    },
  );

  return { Message };
});

vi.mock("@/components/ai-elements/reasoning", () => {
  const Reasoning = Object.assign(
    ({
      children,
      isStreaming,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { isStreaming?: boolean }) => (
      <div
        data-streaming={isStreaming ? "true" : "false"}
        data-testid="reasoning"
        {...props}
      >
        {children}
      </div>
    ),
    {
      Content: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
      ),
      Trigger: () => null,
    },
  );

  return { Reasoning };
});

vi.mock("@/components/ai-elements/response", () => ({
  Response: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/sources", () => {
  const Sources = Object.assign(
    ({ children }: { children: React.ReactNode }) => (
      <div data-testid="sources">{children}</div>
    ),
    {
      Content: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
      ),
      Source: ({ href, title }: { href?: string; title?: string }) => (
        <a href={href}>{title}</a>
      ),
      Trigger: ({ count }: { count: number }) => (
        <button type="button">Used {count} sources</button>
      ),
    },
  );

  return { Sources };
});

vi.mock("@/components/ai-elements/tool", () => {
  const Tool = Object.assign(
    ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    {
      Content: ({ children }: { children: React.ReactNode }) => (
        <div>{children}</div>
      ),
      Header: ({ type }: { type: string }) => <div>{type}</div>,
      Input: () => null,
      Output: () => null,
    },
  );

  return { Tool };
});

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
  it("renders assistant text with the same flat message surface as chat messages", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-flat",
        role: "assistant",
        parts: [{ type: "text", text: "Flat assistant answer." }],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(
      screen
        .getByText("Flat assistant answer.")
        .closest("[data-message-content-variant]"),
    ).toHaveAttribute("data-message-content-variant", "flat");
    expect(
      screen
        .getByText("Flat assistant answer.")
        .closest("[data-message-focus-surface]"),
    ).toHaveClass("items-start");
  });

  it("renders user text with the same flat message surface as chat messages", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "user-flat",
        role: "user",
        parts: [{ type: "text", text: "Flat user question." }],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(
      screen
        .getByText("Flat user question.")
        .closest("[data-message-content-variant]"),
    ).toHaveAttribute("data-message-content-variant", "flat");
    expect(
      screen
        .getByText("Flat user question.")
        .closest("[data-message-focus-surface]"),
    ).toHaveClass("items-end");
  });

  it("renders grouped SDK sources after the assistant answer", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-sources",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the answer." },
          {
            type: "source-url",
            sourceId: "source-1",
            url: "https://example.com/report",
            title: "Example Report",
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    const answer = screen.getByText("Here is the answer.");
    const sources = screen.getByTestId("sources");

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Example Report" }),
    ).toHaveAttribute("href", "https://example.com/report");
    expect(
      answer.compareDocumentPosition(sources) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("deduplicates SDK sources in read-only threads", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-sources",
        role: "assistant",
        parts: [
          { type: "text", text: "Answer with sources." },
          {
            type: "source-url",
            sourceId: "source-1",
            url: "https://example.com/one",
            title: "First title",
          },
          {
            type: "source-url",
            sourceId: "source-1",
            url: "https://example.com/two",
            title: "Second title",
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "First title" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Second title")).not.toBeInTheDocument();
  });

  it("renders SDK source documents without links in read-only threads", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-document-source",
        role: "assistant",
        parts: [
          { type: "text", text: "Document-backed answer." },
          {
            type: "source-document",
            sourceId: "doc-1",
            title: "Planning Notes",
            filename: "planning.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    expect(screen.getByText("Planning Notes")).toBeInTheDocument();
    expect(
      screen.getByText("planning.pdf - application/pdf"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Planning Notes" }),
    ).not.toBeInTheDocument();
  });

  it("keeps internal SDK and transport parts hidden in read-only threads", () => {
    const messages = [
      {
        id: "assistant-internals",
        role: "assistant",
        parts: [
          { type: "text", text: "Visible answer." },
          { type: "step-start" },
          {
            type: "data-heartbeat",
            data: { timestamp: 1 },
          },
          {
            type: "data-token-usage",
            data: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        ],
      },
    ] as unknown as PartialUIMessage[];

    render(<MessageThread messages={messages} />);

    expect(screen.getByText("Visible answer.")).toBeInTheDocument();
    expect(screen.queryByText("step-start")).not.toBeInTheDocument();
    expect(screen.queryByText("data-heartbeat")).not.toBeInTheDocument();
    expect(screen.queryByText("data-token-usage")).not.toBeInTheDocument();
  });

  it("reserves conversation rhythm for read-only reasoning blocks", () => {
    const messages = [
      {
        id: "assistant-reasoning",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Checking the read-only thread spacing.",
            state: "streaming",
          },
        ],
      },
    ] as unknown as PartialUIMessage[];

    render(<MessageThread messages={messages} />);

    const rhythmBlock = screen
      .getByTestId("reasoning")
      .closest("[data-chat-part-block]");

    expect(screen.getByTestId("reasoning")).toHaveAttribute(
      "data-streaming",
      "true",
    );
    expect(rhythmBlock).toHaveClass("pb-8");
  });

  it("reserves conversation rhythm for read-only file attachments", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-file",
        role: "assistant",
        parts: [
          {
            type: "file",
            url: "https://example.com/summary.pdf",
            mediaType: "application/pdf",
            filename: "summary.pdf",
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    const rhythmBlock = screen
      .getByText("summary.pdf")
      .closest("[data-chat-part-block]");

    expect(rhythmBlock).toHaveClass("pb-8");
  });

  it("reserves conversation rhythm for read-only tool blocks", () => {
    const messages: PartialUIMessage[] = [
      {
        id: "assistant-tool",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            toolName: "github__get_issue",
            state: "input-available",
            input: { issue_number: 1 },
          },
        ],
      },
    ];

    render(<MessageThread messages={messages} />);

    const rhythmBlock = screen
      .getByText("tool-github__get_issue")
      .closest("[data-chat-part-block]");

    expect(rhythmBlock).toHaveClass("pb-8");
    expect(rhythmBlock).toHaveClass("px-4");
  });

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
