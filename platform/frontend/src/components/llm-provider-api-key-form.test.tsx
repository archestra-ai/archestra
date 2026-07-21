import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";
import {
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  type LlmProviderApiKeyResponse,
} from "./llm-provider-api-key-form";

const DEFAULTS: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "openai",
  apiKey: null,
  baseUrl: null,
  inferenceBaseUrl: null,
  extraHeaders: [],
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: false,
  bedrockAuthMethod: "api-key",
  openaiAuthMethod: "api-key",
  awsAccessKeyId: null,
  awsSecretAccessKey: null,
  awsSessionToken: null,
};

// The form receives `form` as a prop; the harness owns a real react-hook-form
// instance so the test can drive provider changes the way the Select does
// (`form.setValue("provider", ...)`) without wrestling the Radix combobox.
let form: UseFormReturn<LlmProviderApiKeyFormValues>;

function Harness({
  existingKeys,
  existingKey,
  defaults,
}: {
  existingKeys?: LlmProviderApiKeyResponse[];
  existingKey?: LlmProviderApiKeyResponse;
  defaults?: Partial<LlmProviderApiKeyFormValues>;
}) {
  form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: { ...DEFAULTS, ...defaults },
  });
  return (
    <LlmProviderApiKeyForm
      form={form}
      mode="full"
      showConsoleLink={false}
      existingKeys={existingKeys}
      existingKey={existingKey}
    />
  );
}

function renderForm(options?: {
  existingKeys?: LlmProviderApiKeyResponse[];
  existingKey?: LlmProviderApiKeyResponse;
  defaults?: Partial<LlmProviderApiKeyFormValues>;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness
        existingKeys={options?.existingKeys}
        existingKey={options?.existingKey}
        defaults={options?.defaults}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(false);
  vi.mocked(useProviderBaseUrls).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useProviderBaseUrls>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useTeams>);
});

describe("LlmProviderApiKeyForm", () => {
  it("clears provider-specific credentials when the provider changes", async () => {
    renderForm();

    act(() => {
      form.setValue("apiKey", "sk-openai-secret");
      form.setValue("baseUrl", "https://openai.example");
      form.setValue("inferenceBaseUrl", "https://openai.example/infer");
      form.setValue("vaultSecretPath", "secret/openai");
      form.setValue("vaultSecretKey", "api_key");
      form.setValue("awsAccessKeyId", "AKIA-openai");
      form.setValue("awsSecretAccessKey", "aws-secret");
      form.setValue("awsSessionToken", "aws-session");
    });
    expect(form.getValues("apiKey")).toBe("sk-openai-secret");

    // A key typed for OpenAI must not be submitted against Anthropic.
    act(() => {
      form.setValue("provider", "anthropic");
    });

    await waitFor(() => {
      // Every provider-specific credential field must be cleared, not just the
      // API key — the AWS/vault fields are the most sensitive to leak across.
      expect(form.getValues("apiKey")).toBeNull();
      expect(form.getValues("baseUrl")).toBeNull();
      expect(form.getValues("inferenceBaseUrl")).toBeNull();
      expect(form.getValues("vaultSecretPath")).toBeNull();
      expect(form.getValues("vaultSecretKey")).toBeNull();
      expect(form.getValues("awsAccessKeyId")).toBeNull();
      expect(form.getValues("awsSecretAccessKey")).toBeNull();
      expect(form.getValues("awsSessionToken")).toBeNull();
    });
  });

  it("resets a stale Bedrock auth method when leaving Bedrock", async () => {
    renderForm();

    act(() => {
      form.setValue("provider", "bedrock");
    });
    // Set IAM only after the bedrock switch settles, so the switch effect
    // doesn't clobber it first.
    act(() => {
      form.setValue("bedrockAuthMethod", "iam");
    });
    expect(form.getValues("bedrockAuthMethod")).toBe("iam");

    // A stale "iam" would hide the API key input on the next provider, so
    // leaving Bedrock must restore the default auth method.
    act(() => {
      form.setValue("provider", "anthropic");
    });

    await waitFor(() => {
      expect(form.getValues("bedrockAuthMethod")).toBe("api-key");
    });
  });

  it("suffixes the auto-filled name when the provider default is taken", async () => {
    // Two reconnects of a sign-in provider (e.g. Microsoft 365 Copilot) must
    // not mint a third identically-named key — the auto-fill counts up past
    // every taken default.
    renderForm({
      existingKeys: [
        {
          provider: "microsoft-365-copilot",
          name: "Microsoft 365 Copilot",
        } as LlmProviderApiKeyResponse,
        {
          provider: "microsoft-365-copilot",
          name: "Microsoft 365 Copilot (2)",
        } as LlmProviderApiKeyResponse,
      ],
    });

    // The default provider (openai) has no name collision.
    await waitFor(() => {
      expect(form.getValues("name")).toBe("OpenAI");
    });

    act(() => {
      form.setValue("provider", "microsoft-365-copilot");
    });

    await waitFor(() => {
      expect(form.getValues("name")).toBe("Microsoft 365 Copilot (3)");
    });
  });

  it("retitles the auto-filled name to match the OpenAI credential type", async () => {
    // Selecting the ChatGPT Subscription tab must rename the auto-filled key
    // from "OpenAI", so it is not saved under the wrong, confusing name.
    renderForm();

    await waitFor(() => {
      expect(form.getValues("name")).toBe("OpenAI");
    });

    act(() => {
      form.setValue("openaiAuthMethod", "chatgpt-subscription");
    });
    await waitFor(() => {
      expect(form.getValues("name")).toBe("ChatGPT Subscription");
    });

    // Switching back to the API-key tab restores the plain provider default.
    act(() => {
      form.setValue("openaiAuthMethod", "api-key");
    });
    await waitFor(() => {
      expect(form.getValues("name")).toBe("OpenAI");
    });
  });

  it("shows the connected card when editing an existing ChatGPT-subscription key", async () => {
    // Editing a key whose stored credential is already a ChatGPT subscription
    // must surface the "connected" card (mirroring Copilot), not silently look
    // like a fresh, unconnected sign-in.
    const existingKey = {
      id: "key-1",
      organizationId: "org-1",
      name: "ChatGPT Subscription",
      provider: "openai",
      secretId: "secret-1",
      scope: "personal",
      userId: "user-1",
      teamId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
      extraHeaders: null,
      isSystem: false,
      isPrimary: false,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      isChatgptSubscription: true,
    } as LlmProviderApiKeyResponse;

    renderForm({
      existingKey,
      defaults: { openaiAuthMethod: "chatgpt-subscription" },
    });

    await waitFor(() => {
      expect(screen.getByText("ChatGPT account connected")).toBeInTheDocument();
    });
  });

  it("does not show the connected card when editing a plain OpenAI key on the subscription tab", async () => {
    // A plain API key being converted to a subscription is not yet connected —
    // the sign-in prompt must show, no false "connected" card.
    const existingKey = {
      id: "key-2",
      organizationId: "org-1",
      name: "OpenAI",
      provider: "openai",
      secretId: "secret-2",
      scope: "personal",
      userId: "user-1",
      teamId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
      extraHeaders: null,
      isSystem: false,
      isPrimary: false,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      isChatgptSubscription: false,
    } as LlmProviderApiKeyResponse;

    renderForm({
      existingKey,
      defaults: { openaiAuthMethod: "chatgpt-subscription" },
    });

    await waitFor(() => {
      expect(screen.getByText(/Sign in with ChatGPT/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText("ChatGPT account connected"),
    ).not.toBeInTheDocument();
  });

  it("keeps the credential when the provider is unchanged", async () => {
    renderForm();

    act(() => {
      form.setValue("apiKey", "sk-openai-secret");
    });

    // No provider change: re-renders must not wipe the typed key.
    await waitFor(() => {
      expect(form.getValues("apiKey")).toBe("sk-openai-secret");
    });
  });
});
