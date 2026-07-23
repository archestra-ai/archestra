import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
} from "./llm-provider-api-key-form";

const DEFAULTS: LlmProviderApiKeyFormValues = {
  name: "My key",
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

let form: UseFormReturn<LlmProviderApiKeyFormValues>;

function Harness({
  overrides,
  allowedProviders,
}: {
  overrides?: Partial<LlmProviderApiKeyFormValues>;
  allowedProviders?: LlmProviderApiKeyFormValues["provider"][];
}) {
  form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: { ...DEFAULTS, ...overrides },
  });
  // Read isDirty during render so RHF's formState proxy subscribes and
  // recomputes it, and expose it for assertion.
  return (
    <>
      <div data-testid="is-dirty">{String(form.formState.isDirty)}</div>
      <LlmProviderApiKeyForm
        form={form}
        mode="full"
        showConsoleLink={false}
        allowedProviders={allowedProviders}
      />
    </>
  );
}

function renderForm(
  overrides?: Partial<LlmProviderApiKeyFormValues>,
  allowedProviders?: LlmProviderApiKeyFormValues["provider"][],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness overrides={overrides} allowedProviders={allowedProviders} />
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

describe("LlmProviderApiKeyForm dirty tracking", () => {
  // The unsaved-changes guard keys off formState.isDirty; the scope selector
  // updates the form via setValue, which only marks dirty when shouldDirty is
  // passed — otherwise the guard never fires for a scope change.
  it("marks the form dirty when the scope changes", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByTestId("is-dirty")).toHaveTextContent("false");

    // The scope selector is collapsed to the current choice ("Personal");
    // expand it, then pick "Organization" — that change must dirty the form.
    await user.click(screen.getByRole("button", { name: /personal/i }));
    await user.click(screen.getByRole("button", { name: /organization/i }));

    await waitFor(() => {
      expect(screen.getByTestId("is-dirty")).toHaveTextContent("true");
    });
  });

  // The transport tabs write `provider` without shouldDirty on purpose: they
  // are a segmented control, so flagging dirty would make merely looking at the
  // other transport prompt "discard changes?" on close.
  it("does not mark the form dirty when the transport changes", async () => {
    const user = userEvent.setup();
    renderForm({ provider: "ollama-native" });

    await user.click(screen.getByRole("radio", { name: "OpenAI-compatible" }));

    await waitFor(() => {
      expect(form.getValues("provider")).toBe("ollama");
    });
    expect(screen.getByTestId("is-dirty")).toHaveTextContent("false");
  });
});

describe("LlmProviderApiKeyForm Ollama transport", () => {
  it("keeps the API key but resets the base URL across a transport switch", async () => {
    const user = userEvent.setup();
    renderForm({ provider: "ollama-native" });

    await user.type(screen.getByLabelText(/api key/i), "secret-token");
    await user.type(screen.getByLabelText(/base url/i), "http://gpu-box:11434");

    await user.click(screen.getByRole("radio", { name: "OpenAI-compatible" }));

    await waitFor(() => {
      expect(form.getValues("provider")).toBe("ollama");
    });
    // Both transports reach the same server with the same credential, so
    // wiping the key here only punished the user for exploring the choice.
    expect(form.getValues("apiKey")).toBe("secret-token");
    // The endpoint genuinely differs (`/v1` or not), so it empties back to the
    // placeholder showing the correct default for the chosen transport.
    expect(screen.getByLabelText(/base url/i)).toHaveValue("");
    expect(form.getValues("baseUrl")).toBeFalsy();
  });

  // The two transports collapse to one "Ollama" entry in the provider list.
  // Callers that restrict the list name only the legacy `ollama` (the clients
  // that support it), so collapsing to `ollama-native` unconditionally left the
  // sole Ollama entry permanently disabled — no way to add a key at all.
  it("selects the caller-allowed transport when only one is permitted", async () => {
    // Deliberately starts on the transport the caller does NOT allow. Starting
    // on "ollama" made the provider assertion vacuous — the effect returns
    // early when the value already matches, so the test passed against the
    // pre-fix source that always collapsed to "ollama-native".
    renderForm({ provider: "ollama-native" }, ["ollama"]);

    await waitFor(() => {
      expect(form.getValues("provider")).toBe("ollama");
    });
    // With the choice already made by the caller, the transport control has
    // nothing to offer — and offering it would let the form mint a key the
    // caller's own setup instructions do not describe.
    expect(
      screen.queryByRole("radio", { name: "OpenAI-compatible" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Native" }),
    ).not.toBeInTheDocument();
  });

  it("clears the API key when leaving Ollama for another provider", async () => {
    // The credential-preservation skip is Ollama-to-Ollama only: the pair is
    // one server with one credential. Any other destination is a different
    // service, so weakening that `&&` to `||` would submit an Ollama key to it.
    renderForm({ provider: "ollama-native", apiKey: "secret-token" });

    form.setValue("provider", "openai");

    await waitFor(() => {
      expect(form.getValues("apiKey")).toBeFalsy();
    });
  });

  it("offers both transports when the caller does not restrict the list", async () => {
    renderForm({ provider: "ollama-native" });

    expect(screen.getByRole("radio", { name: "Native" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "OpenAI-compatible" }),
    ).toBeInTheDocument();
  });
});
