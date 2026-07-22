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

function Harness() {
  form = useForm<LlmProviderApiKeyFormValues>({ defaultValues: DEFAULTS });
  // Read isDirty during render so RHF's formState proxy subscribes and
  // recomputes it, and expose it for assertion.
  return (
    <>
      <div data-testid="is-dirty">{String(form.formState.isDirty)}</div>
      <LlmProviderApiKeyForm form={form} mode="full" showConsoleLink={false} />
    </>
  );
}

function renderForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
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
});
