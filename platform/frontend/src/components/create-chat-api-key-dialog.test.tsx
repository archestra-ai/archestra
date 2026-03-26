import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateChatApiKeyDialog } from "./create-chat-api-key-dialog";

const mutateAsync = vi.fn();

vi.mock("@/components/chat-api-key-form", () => ({
  PLACEHOLDER_KEY: "••••••••••••••••",
  ChatApiKeyForm: ({
    form,
  }: {
    form: { register: (name: string) => Record<string, unknown> };
  }) => (
    <div>
      <label htmlFor="chat-api-key-name">Name</label>
      <input id="chat-api-key-name" {...form.register("name")} />
      <label htmlFor="chat-api-key-value">API Key</label>
      <input id="chat-api-key-value" {...form.register("apiKey")} />
    </div>
  ),
}));

vi.mock("@/lib/chat/chat-settings.query", () => ({
  useChatApiKeys: () => ({ data: [] }),
  useCreateChatApiKey: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

describe("CreateChatApiKeyDialog", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
  });

  it("submits the shared create API key flow and closes on success", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <CreateChatApiKeyDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        title="Add API Key"
        description="Shared dialog"
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Primary OpenAI Key");
    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: /test & create/i }));

    expect(mutateAsync).toHaveBeenCalledWith({
      name: "Primary OpenAI Key",
      provider: "anthropic",
      apiKey: "sk-test",
      baseUrl: undefined,
      scope: "personal",
      teamId: undefined,
      isPrimary: false,
      vaultSecretPath: undefined,
      vaultSecretKey: undefined,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
