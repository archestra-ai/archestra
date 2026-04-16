import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

import { InlineChatError } from "./inline-chat-error";

describe("InlineChatError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows only the support message and correlation IDs in slim mode", () => {
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "server_error",
              message: "The provider failed",
              isRetryable: true,
              sessionId: "session-12345678",
              traceId: "trace-12345678",
              spanId: "span-12345678",
              originalError: {
                provider: "openai",
                message: "secret provider detail",
              },
            }),
          )
        }
        supportMessage="Contact support@example.com and include these IDs."
        slimChatErrorUi
      />,
    );

    expect(
      screen.getByText("Contact support@example.com and include these IDs."),
    ).toBeInTheDocument();
    expect(screen.getByText("session-12345678")).toBeInTheDocument();
    expect(screen.getByText("trace-12345678")).toBeInTheDocument();
    expect(screen.getByText("span-12345678")).toBeInTheDocument();
    expect(screen.queryByText("openai")).not.toBeInTheDocument();
    expect(
      screen.queryByText("secret provider detail"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy error details" }),
    ).toBeInTheDocument();
  });

  it("falls back to the mapped error message in slim mode without a support message", () => {
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "server_error",
              message: "The provider failed",
              isRetryable: true,
              sessionId: "session-12345678",
              traceId: "trace-12345678",
              spanId: "span-12345678",
              originalError: {
                provider: "openai",
                message: "secret provider detail",
              },
            }),
          )
        }
        slimChatErrorUi
      />,
    );

    expect(screen.getByText("The provider failed")).toBeInTheDocument();
    expect(screen.getByText("session-12345678")).toBeInTheDocument();
    expect(screen.getByText("trace-12345678")).toBeInTheDocument();
    expect(screen.getByText("span-12345678")).toBeInTheDocument();
    expect(screen.queryByText("openai")).not.toBeInTheDocument();
    expect(
      screen.queryByText("secret provider detail"),
    ).not.toBeInTheDocument();
  });

  it("still shows a copy button in slim mode when no IDs are available", () => {
    render(
      <InlineChatError error={new Error("Failed to fetch")} slimChatErrorUi />,
    );

    expect(
      screen.getByRole("button", { name: "Copy error details" }),
    ).toBeInTheDocument();
  });

  it("keeps the detailed error UI by default", () => {
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "server_error",
              message: "The provider failed",
              isRetryable: true,
              sessionId: "session-12345678",
              traceId: "trace-12345678",
              spanId: "span-12345678",
              originalError: {
                provider: "openai",
                message: "secret provider detail",
              },
            }),
          )
        }
        agentName="Support Agent"
        selectedModel="gpt-5"
        modelSource="organization"
      />,
    );

    expect(screen.getByText("Support Agent")).toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy debug info" }),
    ).toBeInTheDocument();
  });

  it("falls back to the structured error message and conversation ID as session", () => {
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "unknown",
              message: "Something went wrong",
              isRetryable: false,
            }),
          )
        }
        conversationId="conversation-12345678"
      />,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("conversation-12345678")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
  });
});
