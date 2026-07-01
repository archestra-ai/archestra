import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useCreateLlmProviderApiKey: () => ({
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ id: "key-1" }),
  }),
}));

// Invoke onToken on click so we can exercise the connect → auto-resend flow.
vi.mock("@/components/github-copilot-sign-in", () => ({
  GithubCopilotSignIn: ({ onToken }: { onToken: (token: string) => void }) => (
    <button type="button" onClick={() => onToken("gho_test")}>
      Sign in with GitHub
    </button>
  ),
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
        supportMessage="Contact your administrator and include these IDs."
        slimChatErrorUi
      />,
    );

    expect(
      screen.getByText("Contact your administrator and include these IDs."),
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

  it("renders an empty-response turn as a neutral outcome, not a destructive error", () => {
    const { container } = render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "empty_response",
              message:
                "The model ended its turn without a reply. Rephrasing your message may help.",
              isRetryable: true,
            }),
          )
        }
      />,
    );

    expect(
      screen.getByText(
        "The model ended its turn without a reply. Rephrasing your message may help.",
      ),
    ).toBeInTheDocument();
    expect(container.querySelector(".bg-destructive\\/10")).toBeNull();
    expect(container.querySelector(".bg-muted\\/30")).not.toBeNull();
  });

  it("renders an incomplete-tool-call turn as a retryable destructive error, not a neutral outcome", () => {
    const { container } = render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "incomplete_tool_call",
              message:
                "The model started a tool call but didn't finish it, so the turn ended without a reply. Retrying may help.",
              isRetryable: true,
            }),
          )
        }
      />,
    );

    expect(container.querySelector(".bg-destructive\\/10")).not.toBeNull();
    expect(container.querySelector(".bg-muted\\/30")).toBeNull();
  });

  it("keeps destructive styling for genuine errors", () => {
    const { container } = render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "server_error",
              message: "The AI provider is experiencing issues.",
              isRetryable: true,
            }),
          )
        }
      />,
    );

    expect(container.querySelector(".bg-destructive\\/10")).not.toBeNull();
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

  it("renders a connect-account card for a per-user provider auth error", () => {
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "provider_auth_required",
              message: "Connect your GitHub Copilot account to use this model.",
              isRetryable: false,
              authAction: {
                provider: "github-copilot",
                providerLabel: "GitHub Copilot",
              },
            }),
          )
        }
      />,
    );

    expect(screen.getByText("Connect GitHub Copilot")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sign in with GitHub/i }),
    ).toBeInTheDocument();
  });

  it("does not claim success when the clipboard write fails", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(
      <InlineChatError error={new Error("Failed to fetch")} slimChatErrorUi />,
    );

    await user.click(
      screen.getByRole("button", { name: "Copy error details" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("toasts success once the clipboard write resolves", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    render(
      <InlineChatError error={new Error("Failed to fetch")} slimChatErrorUi />,
    );

    await user.click(
      screen.getByRole("button", { name: "Copy error details" }),
    );

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("auto-resends the original prompt after connecting the provider", async () => {
    const onProviderConnected = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineChatError
        error={
          new Error(
            JSON.stringify({
              code: "provider_auth_required",
              message: "Connect your GitHub Copilot account to use this model.",
              isRetryable: false,
              authAction: {
                provider: "github-copilot",
                providerLabel: "GitHub Copilot",
              },
            }),
          )
        }
        onProviderConnected={onProviderConnected}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Sign in with GitHub/i }),
    );

    await waitFor(() => expect(onProviderConnected).toHaveBeenCalledTimes(1));
  });

  const retryableError = () =>
    new Error(
      JSON.stringify({
        code: "network_error",
        message: "Connection error. Please check your network and try again.",
        isRetryable: true,
      }),
    );

  const nonRetryableError = () =>
    new Error(
      JSON.stringify({
        code: "authentication",
        message: "Authentication failed.",
        isRetryable: false,
      }),
    );

  it("shows a Try again button for a retryable error and calls onRetry", async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InlineChatError error={retryableError()} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides Try again for a non-retryable error even when onRetry is provided", () => {
    render(<InlineChatError error={nonRetryableError()} onRetry={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("hides Try again for a retryable error when no onRetry is provided", () => {
    render(<InlineChatError error={retryableError()} />);

    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("disables Try again while a retry is in flight so it cannot double-fire", async () => {
    let resolveRetry: (() => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<InlineChatError error={retryableError()} onRetry={onRetry} />);

    const button = screen.getByRole("button", { name: "Try again" });
    await user.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toBeDisabled());

    await user.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);

    resolveRetry?.();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
