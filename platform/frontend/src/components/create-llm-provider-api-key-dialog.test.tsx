import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { CreateLlmProviderApiKeyDialog } from "./create-llm-provider-api-key-dialog";

const mutateAsync = vi.fn();

vi.mock("@/components/llm-provider-api-key-form", () => ({
  LLM_PROVIDER_API_KEY_PLACEHOLDER: "••••••••••••••••",
  serializeExtraHeaders: () => null,
  PROVIDER_CONFIG: {
    anthropic: { name: "Anthropic" },
    archestra: { name: "Archestra", baseUrlRequired: true },
  },
  // Mirrors the real helper's formula (provider opts in via PROVIDER_CONFIG,
  // an admin-configured providerBaseUrls entry satisfies it) against this
  // file's own stub PROVIDER_CONFIG, so getIsCreateFormValid's own wiring is
  // what's under test here — not re-deriving the requirement from scratch.
  isBaseUrlRequiredForProvider: ({
    provider,
    providerBaseUrls,
  }: {
    provider: string;
    providerBaseUrls: Record<string, string | null> | null | undefined;
  }) => provider === "archestra" && !providerBaseUrls?.[provider],
  LlmProviderApiKeyForm: ({
    form,
  }: {
    form: { register: (name: string) => Record<string, unknown> };
  }) => (
    <div>
      <label htmlFor="chat-api-key-name">Name</label>
      <input id="chat-api-key-name" {...form.register("name")} />
      <label htmlFor="chat-api-key-value">API Key</label>
      <input id="chat-api-key-value" {...form.register("apiKey")} />
      <label htmlFor="chat-api-key-base-url">Base URL</label>
      <input id="chat-api-key-base-url" {...form.register("baseUrl")} />
    </div>
  ),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
  useCreateLlmProviderApiKey: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

// The post-create confirmation view fetches the new key's models.
vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({ data: [], isPending: false }),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/auth/auth.query");

describe("CreateLlmProviderApiKeyDialog", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ id: "new-key-id" });
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useHasPermissions).mockReset();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useProviderBaseUrls).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useProviderBaseUrls>);
  });

  it("confirms with the model list, then closes and reports success on Done", async () => {
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

    // The create flow no longer closes on submit — it confirms with the new
    // key's model list first, and only closes when the user clicks Done.
    const doneButton = await screen.findByRole("button", { name: /^done$/i });
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(doneButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("reports success exactly once when the confirmation screen is dismissed via Escape instead of Done", async () => {
    // BUG 2: closing through any path other than the "Done" button (X,
    // Escape, outside click) must still call onSuccess — otherwise the
    // first-run chat onboarding silently skips its next step.
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

    await user.type(screen.getByLabelText("API Key"), "sk-test");
    await user.click(screen.getByRole("button", { name: /test & create/i }));
    await screen.findByRole("button", { name: /^done$/i });

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("disables submit until a required Base URL is filled, for a provider that needs one", async () => {
    // BUG 1: getIsCreateFormValid must account for base-URL requiredness —
    // otherwise the button stays enabled while the (possibly hidden) field
    // blocks the submit with no visible error.
    const user = userEvent.setup();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        title="Add API Key"
        description="Shared dialog"
        defaultValues={{ provider: "archestra" }}
      />,
    );

    await user.type(screen.getByLabelText("API Key"), "arch-test");
    expect(
      screen.getByRole("button", { name: /test & create/i }),
    ).toBeDisabled();

    await user.type(
      screen.getByLabelText("Base URL"),
      "https://my-archestra/v1",
    );
    expect(
      screen.getByRole("button", { name: /test & create/i }),
    ).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: /test & create/i }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://my-archestra/v1" }),
    );
  });

  it("does not require a Base URL once an admin-configured override exists", async () => {
    vi.mocked(useProviderBaseUrls).mockReturnValue({
      data: { archestra: "https://configured.example.com" },
    } as unknown as ReturnType<typeof useProviderBaseUrls>);
    const user = userEvent.setup();

    render(
      <CreateLlmProviderApiKeyDialog
        open
        onOpenChange={vi.fn()}
        title="Add API Key"
        description="Shared dialog"
        defaultValues={{ provider: "archestra" }}
      />,
    );

    await user.type(screen.getByLabelText("API Key"), "arch-test");
    expect(
      screen.getByRole("button", { name: /test & create/i }),
    ).not.toBeDisabled();
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
});
