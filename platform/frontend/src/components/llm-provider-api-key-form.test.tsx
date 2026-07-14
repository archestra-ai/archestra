import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
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
}: {
  existingKeys?: LlmProviderApiKeyResponse[];
}) {
  form = useForm<LlmProviderApiKeyFormValues>({ defaultValues: DEFAULTS });
  return (
    <LlmProviderApiKeyForm
      form={form}
      mode="full"
      showConsoleLink={false}
      existingKeys={existingKeys}
    />
  );
}

function renderForm(options?: { existingKeys?: LlmProviderApiKeyResponse[] }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness existingKeys={options?.existingKeys} />
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
