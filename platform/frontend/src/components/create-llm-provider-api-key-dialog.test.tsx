import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import { CreateLlmProviderApiKeyDialog } from "./create-llm-provider-api-key-dialog";

const mutateAsync = vi.fn();
const reconnectMutateAsync = vi.fn();

vi.mock("@/components/llm-provider-api-key-form", () => ({
  LLM_PROVIDER_API_KEY_PLACEHOLDER: "••••••••••••••••",
  serializeExtraHeaders: () => null,
  PROVIDER_CONFIG: { anthropic: { name: "Anthropic" } },
  LlmProviderApiKeyForm: ({
    form,
    credentialMode,
    onSubscriptionCredential,
  }: {
    form: { register: (name: string) => Record<string, unknown> };
    credentialMode?: "api-key" | "subscription";
    onSubscriptionCredential?: (credential: string) => void;
  }) => (
    <div>
      {credentialMode === "subscription" ? (
        <button
          type="button"
          onClick={() => onSubscriptionCredential?.("subscription-token")}
        >
          Sign in
        </button>
      ) : (
        <>
          <label htmlFor="chat-api-key-name">Name</label>
          <input id="chat-api-key-name" {...form.register("name")} />
          <label htmlFor="chat-api-key-value">API Key</label>
          <input id="chat-api-key-value" {...form.register("apiKey")} />
        </>
      )}
    </div>
  ),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
  useCreateLlmProviderApiKey: () => ({
    mutateAsync,
    isPending: false,
  }),
  useReconnectLlmProviderApiKey: () => ({
    mutateAsync: reconnectMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

describe("CreateLlmProviderApiKeyDialog", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ id: "created-key-id" });
    reconnectMutateAsync.mockReset();
    reconnectMutateAsync.mockResolvedValue({ id: "existing-key-id" });
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useHasPermissions).mockReset();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useOrganization>);
  });

  it("submits the shared create API key flow and closes on success", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <CreateLlmProviderApiKeyDialog
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
      extraHeaders: undefined,
      scope: "personal",
      teamId: undefined,
      isPrimary: false,
      vaultSecretPath: undefined,
      vaultSecretKey: undefined,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledWith("created-key-id");
  });

  it("falls back to the provider name when the name field is empty", async () => {
    const user = userEvent.setup();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        title="Add API Key"
        description="Shared dialog"
      />,
    );

    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: /test & create/i }));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Anthropic" }),
    );
  });

  it("defaults the scope to org when the user has llmProviderApiKey:admin", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    const user = userEvent.setup();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        title="Add API Key"
        description="Shared dialog"
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Org Wide Key");
    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: /test & create/i }));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "org" }),
    );
  });

  it("creates a subscription immediately after sign-in", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        onSuccess={onSuccess}
        title="Sign in with ChatGPT"
        description="Connect your ChatGPT account"
        credentialMode="subscription"
        allowedProviders={["openai"]}
        defaultValues={{
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          authMethod: "subscription",
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Test & Create" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ChatGPT Subscription",
        provider: "openai",
        apiKey: "subscription-token",
        scope: "personal",
      }),
    );
    expect(onSuccess).toHaveBeenCalledWith("created-key-id");
  });

  it("forces personal scope for a subscription sign-in even when the form holds a shared scope", async () => {
    // Scope coercion in the form is deferred until sign-in completes, and the
    // sign-in callback reads form values in the same tick the credential
    // lands — so the payload must resolve the scope itself.
    const user = userEvent.setup();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        title="Sign in with ChatGPT"
        description="Connect your ChatGPT account"
        credentialMode="subscription"
        allowedProviders={["openai"]}
        defaultValues={{
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "org",
          authMethod: "subscription",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "personal", teamId: undefined }),
    );
  });

  it("rotates the existing credential in place when reconnecting a subscription", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
        title="Reconnect ChatGPT Subscription"
        description="Sign in again"
        credentialMode="subscription"
        allowedProviders={["openai"]}
        reconnectKeyId="existing-key-id"
        defaultValues={{
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          authMethod: "subscription",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // The fresh credential replaces the stored secret via the self-service
    // reconnect endpoint (default members lack llmProviderApiKey:update, so
    // the PATCH route would 403); no duplicate key row.
    expect(reconnectMutateAsync).toHaveBeenCalledWith({
      id: "existing-key-id",
      apiKey: "subscription-token",
    });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledWith("existing-key-id");
  });
});
