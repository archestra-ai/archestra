import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { UseSubscriptionDialog } from "./use-subscription-dialog";

// Stub the device-flow sign-in components so the row renders without their
// query hooks; we only assert whether a "Sign in with X" affordance is present.
vi.mock("@/components/github-copilot-sign-in", () => ({
  GithubCopilotSignIn: () => <button type="button">Sign in with GitHub</button>,
}));

vi.mock("@/components/microsoft-365-copilot-sign-in", () => ({
  Microsoft365CopilotSignIn: () => (
    <button type="button">Sign in with Microsoft</button>
  ),
}));

vi.mock("@/components/openai-codex-sign-in", () => ({
  OpenaiCodexSignIn: () => <button type="button">Sign in with ChatGPT</button>,
}));

vi.mock("@/components/llm-provider-api-key-form", () => ({
  CHATGPT_SUBSCRIPTION_LABEL: "ChatGPT subscription",
  PROVIDER_CONFIG: {
    openai: { icon: "/openai.svg", name: "OpenAI" },
    "github-copilot": { icon: "/github-copilot.svg", name: "GitHub Copilot" },
    "microsoft-365-copilot": {
      icon: "/microsoft-365-copilot.svg",
      name: "Microsoft 365 Copilot",
    },
  },
}));

vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div>{children}</div> : null),
}));

vi.mock("@/components/ui/dialog", () => ({
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useCreateLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useLlmProviderApiKeys: () => ({ data: [] }),
}));

vi.mock("@/lib/config/config.query");

describe("UseSubscriptionDialog", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockReturnValue(false);
  });

  it("explains the missing Microsoft 365 sign-in when it isn't configured", () => {
    // useFeature("microsoft365CopilotSignInConfigured") -> false
    vi.mocked(useFeature).mockReturnValue(false);

    render(<UseSubscriptionDialog open onOpenChange={vi.fn()} />);

    expect(
      screen.getByText(/administrator hasn't enabled Microsoft 365 Copilot/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in with microsoft/i }),
    ).not.toBeInTheDocument();
    // The other subscriptions stay connectable.
    expect(
      screen.getByRole("button", { name: /sign in with chatgpt/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeInTheDocument();
  });

  it("offers the Microsoft 365 sign-in once it is configured", () => {
    vi.mocked(useFeature).mockReturnValue(true);

    render(<UseSubscriptionDialog open onOpenChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /sign in with microsoft/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/administrator hasn't enabled/i),
    ).not.toBeInTheDocument();
  });
});
