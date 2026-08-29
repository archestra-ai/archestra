import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type UseFormReturn, useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/organization.query");

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import {
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  type LlmProviderApiKeyResponse,
} from "./llm-provider-api-key-form";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

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
  authMethod: "api-key",
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
  credentialMode,
  progressive,
  allowPersonalSubscriptions,
  requiresExactSubscriptionCredential,
}: {
  existingKeys?: LlmProviderApiKeyResponse[];
  existingKey?: LlmProviderApiKeyResponse;
  defaults?: Partial<LlmProviderApiKeyFormValues>;
  credentialMode?: "api-key" | "subscription";
  progressive?: boolean;
  allowPersonalSubscriptions?: boolean;
  requiresExactSubscriptionCredential?: boolean;
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
      credentialMode={credentialMode}
      progressive={progressive}
      allowPersonalSubscriptions={allowPersonalSubscriptions}
      requiresExactSubscriptionCredential={requiresExactSubscriptionCredential}
    />
  );
}

function renderForm(options?: {
  existingKeys?: LlmProviderApiKeyResponse[];
  existingKey?: LlmProviderApiKeyResponse;
  defaults?: Partial<LlmProviderApiKeyFormValues>;
  credentialMode?: "api-key" | "subscription";
  progressive?: boolean;
  allowPersonalSubscriptions?: boolean;
  requiresExactSubscriptionCredential?: boolean;
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
        credentialMode={options?.credentialMode}
        progressive={options?.progressive}
        allowPersonalSubscriptions={options?.allowPersonalSubscriptions}
        requiresExactSubscriptionCredential={
          options?.requiresExactSubscriptionCredential
        }
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
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
});

describe("LlmProviderApiKeyForm", () => {
  it("shows only sign-in content for a focused subscription flow", () => {
    renderForm({
      credentialMode: "subscription",
      defaults: {
        provider: "openai",
        authMethod: "subscription",
      },
    });

    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
    expect(screen.queryByText("Primary key")).not.toBeInTheDocument();
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Extra HTTP headers")).not.toBeInTheDocument();
  });

  it("explains why subscription sign-in is unavailable with BYOS", () => {
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "byosEnabled",
    );
    renderForm({
      credentialMode: "subscription",
      defaults: {
        provider: "xai",
        authMethod: "subscription",
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Subscription sign-in is unavailable with Bring Your Own Secrets",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Store a provider API key in Vault instead",
    );
    expect(
      screen.queryByRole("button", { name: /Sign in with Grok/i }),
    ).not.toBeInTheDocument();
  });

  it("does not offer an impossible Vault API-key fallback for subscription-only providers", () => {
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "byosEnabled",
    );
    renderForm({
      credentialMode: "subscription",
      defaults: { provider: "github-copilot" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This provider has no API-key alternative",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Store a provider API key in Vault instead",
    );
  });

  it("does not offer an ordinary Vault key for an exact-subscription agent pin", () => {
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "byosEnabled",
    );
    renderForm({
      credentialMode: "subscription",
      requiresExactSubscriptionCredential: true,
      defaults: {
        provider: "xai",
        authMethod: "subscription",
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This agent requires the same personal subscription",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "choose a different agent or model",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Store a provider API key in Vault instead",
    );
  });

  it("reveals optional API key settings progressively", async () => {
    const user = userEvent.setup();
    renderForm({ credentialMode: "api-key", progressive: true });

    expect(screen.getByLabelText("Provider")).toBeInTheDocument();
    expect(screen.getByText("API Key")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.queryByText("Primary key")).not.toBeInTheDocument();
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Extra HTTP headers")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced settings" }));

    expect(screen.getByText("Primary key")).toBeInTheDocument();
    expect(screen.getByText("Base URL")).toBeInTheDocument();
    expect(screen.getByText("Extra HTTP headers")).toBeInTheDocument();
  });

  it("excludes subscription-only providers from the API key flow", async () => {
    const user = userEvent.setup();
    renderForm({
      credentialMode: "api-key",
      progressive: true,
      allowPersonalSubscriptions: false,
    });

    await user.click(screen.getByLabelText("Provider"));

    expect(screen.queryByText("GitHub Copilot")).not.toBeInTheDocument();
    expect(screen.queryByText("Microsoft 365 Copilot")).not.toBeInTheDocument();
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
  });

  it("finds the OpenAI-compatible entry by the server the operator runs", async () => {
    // Self-hosted servers (llama.cpp, LM Studio, SGLang, TGI, LocalAI) all
    // route through the `vllm` provider. Searching for the one you run has to
    // land on it — nobody types "vLLM" looking for LM Studio.
    const user = userEvent.setup();
    renderForm({ credentialMode: "api-key", progressive: true });

    await user.click(screen.getByLabelText("Provider"));
    await user.type(
      screen.getByPlaceholderText("Search providers..."),
      "lm studio",
    );

    const match = await screen.findByRole("button", {
      name: /OpenAI-compatible/,
    });
    expect(match).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^OpenAI$/ })).toBeNull();

    await user.click(match);

    await waitFor(() => {
      expect(form.getValues("provider")).toBe("vllm");
    });
  });

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
      form.setValue("authMethod", "subscription");
    });
    await waitFor(() => {
      expect(form.getValues("name")).toBe("ChatGPT Subscription");
    });

    // Switching back to the API-key tab restores the plain provider default.
    act(() => {
      form.setValue("authMethod", "api-key");
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
      subscriptionKind: "chatgpt",
    } as LlmProviderApiKeyResponse;

    renderForm({
      existingKey,
      defaults: { authMethod: "subscription" },
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
    } as LlmProviderApiKeyResponse;

    renderForm({
      existingKey,
      defaults: { authMethod: "subscription" },
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

  describe("vLLM endpoint", () => {
    it("asks for the server URL up front", async () => {
      // A vLLM key is a server, not an account: the endpoint decides which
      // models the key can reach, and blank routes to api.openai.com.
      renderForm({ defaults: { provider: "vllm" }, progressive: true });

      await waitFor(() => {
        expect(screen.getByText("Base URL")).toBeInTheDocument();
      });
      expect(
        screen.queryByRole("button", { name: "Advanced settings" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Base URL").textContent).not.toContain(
        "optional",
      );
    });

    it("treats a server-wide vLLM endpoint as an overridable default", async () => {
      vi.mocked(useProviderBaseUrls).mockReturnValue({
        data: { vllm: "http://vllm:8000/v1" },
      } as unknown as ReturnType<typeof useProviderBaseUrls>);

      renderForm({ defaults: { provider: "vllm" }, progressive: true });

      // The deployment's endpoint answers "where", so the field stops being
      // required — but a second vLLM server is added by overriding it per key,
      // so it stays visible with the inherited URL as its placeholder.
      await waitFor(() => {
        expect(screen.getByText("Base URL")).toBeInTheDocument();
      });
      expect(screen.getByText("Base URL").textContent).toContain("optional");
      expect(
        screen.getByLabelText(/Base URL/).getAttribute("placeholder"),
      ).toBe("http://vllm:8000/v1");
    });
  });

  describe("Base URL placement", () => {
    /**
     * A field rendered after the "Advanced settings" disclosure reads as part
     * of it. For providers where the endpoint *is* the credential, that hid
     * the one field the key cannot work without.
     */
    function baseUrlPrecedesAdvancedSettings(): boolean {
      const baseUrl = screen.getByText("Base URL");
      const advanced = screen.getByRole("button", {
        name: /Advanced settings/,
      });
      return Boolean(
        baseUrl.compareDocumentPosition(advanced) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    it.each([
      "vllm",
      "ollama",
      "ollama-native",
      "archestra",
    ] as const)("shows the endpoint above Advanced settings for %s", async (provider) => {
      renderForm({ defaults: { provider }, progressive: true });

      await waitFor(() => {
        expect(screen.getByText("Base URL")).toBeInTheDocument();
      });
      expect(baseUrlPrecedesAdvancedSettings()).toBe(true);
    });

    it("keeps the endpoint inside Advanced settings for a cloud provider", async () => {
      const user = userEvent.setup();
      renderForm({ defaults: { provider: "openai" }, progressive: true });

      await waitFor(() => {
        expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
      });
      expect(screen.queryByText("Base URL")).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: /Advanced settings/ }),
      );
      expect(baseUrlPrecedesAdvancedSettings()).toBe(false);
    });

    it("puts the Bedrock region above Advanced settings and its endpoint inside", async () => {
      const user = userEvent.setup();
      renderForm({ defaults: { provider: "bedrock" }, progressive: true });

      await waitFor(() => {
        expect(screen.getByText("Region")).toBeInTheDocument();
      });
      const advanced = screen.getByRole("button", {
        name: /Advanced settings/,
      });
      expect(
        screen.getByText("Region").compareDocumentPosition(advanced) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      expect(screen.queryByText("Custom endpoint")).not.toBeInTheDocument();
      await user.click(advanced);
      expect(
        screen.getByText("Custom endpoint").compareDocumentPosition(advanced) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    });
  });

  describe("Bedrock region", () => {
    it("asks for a region instead of requiring a base URL", async () => {
      renderForm({ defaults: { provider: "bedrock" } });

      // AWS publishes no "base URL" for Bedrock, so demanding one was a dead end.
      await waitFor(() => {
        expect(screen.getByLabelText("Region")).toBeInTheDocument();
      });
      expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Base URL is required for this provider"),
      ).not.toBeInTheDocument();
    });

    it("shows the region carried by an existing key's endpoint", async () => {
      renderForm({
        defaults: {
          provider: "bedrock",
          baseUrl: "https://bedrock-runtime.ap-southeast-2.amazonaws.com",
        },
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Region")).toHaveTextContent(
          "ap-southeast-2",
        );
      });
    });

    it("defaults to the region Bedrock would fall back to anyway", async () => {
      renderForm({ defaults: { provider: "bedrock" } });

      // Not an arbitrary default: it mirrors the backend's getBedrockRegion
      // fallback, so an untouched picker shows what would actually be used.
      await waitFor(() => {
        expect(screen.getByLabelText("Region")).toHaveTextContent("us-east-1");
      });
    });

    it("warns when a custom endpoint carries no recognizable region", async () => {
      renderForm({
        defaults: {
          provider: "bedrock",
          baseUrl: "https://my-bedrock-gateway.internal/v1",
        },
      });

      // The backend silently falls back to us-east-1 here, which is exactly the
      // surprise this copy exists to prevent.
      await waitFor(() => {
        expect(
          screen.getByText(/carries no recognizable region/),
        ).toBeInTheDocument();
      });
    });
  });

  // Admins can rename a provider (see the model-provider settings dialog), and
  // the form's own copy has to follow: a deployment that calls Bedrock
  // something else should never read a sentence about "Bedrock".
  describe("copy for a renamed provider", () => {
    const renameBedrock = (displayName: string) =>
      vi.mocked(useOrganization).mockReturnValue({
        data: { modelProviderOverrides: { bedrock: { displayName } } },
      } as unknown as ReturnType<typeof useOrganization>);

    it("names the provider the way the organization does", async () => {
      renameBedrock("Northwind Model Cloud");
      renderForm({ defaults: { provider: "bedrock" } });

      await waitFor(() => {
        expect(
          screen.getByText(/region to send Northwind Model Cloud requests to/),
        ).toBeInTheDocument();
      });
    });

    it("keeps the vendor's own name for the region itself", async () => {
      renameBedrock("Northwind Model Cloud");
      renderForm({ defaults: { provider: "bedrock" } });

      // "AWS" is the vendor, not this provider: renaming it would point at
      // something that does not exist.
      await waitFor(() => {
        expect(screen.getByText(/^The AWS region to send/)).toBeInTheDocument();
      });
    });

    it("falls back to the built-in name when nothing is overridden", async () => {
      renderForm({ defaults: { provider: "bedrock" } });

      await waitFor(() => {
        expect(
          screen.getByText(/region to send AWS Bedrock requests to/),
        ).toBeInTheDocument();
      });
    });
  });
});
