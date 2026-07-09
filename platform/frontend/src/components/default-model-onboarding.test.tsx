import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Key = { id: string; name: string; provider: string; scope: string };

const KEY: Key = {
  id: "key-1",
  name: "OpenAI - org",
  provider: "openai",
  scope: "org",
};

const ANTHROPIC_KEY: Key = {
  id: "key-2",
  name: "Anthropic - org",
  provider: "anthropic",
  scope: "org",
};

type ModelStub = {
  id: string;
  dbId: string;
  provider: string;
  displayName: string;
  isFree: boolean;
  isBest: boolean;
};

const OPENAI_MODEL: ModelStub = {
  id: "model-1",
  dbId: "model-1",
  provider: "openai",
  displayName: "Model 1",
  isFree: false,
  isBest: true,
};

let mockAvailableKeys: Key[] = [KEY];
// The models query serves this verbatim; tests flip `isPlaceholderData` to
// simulate `keepPreviousData` holding the previous key's list during a switch.
let mockModelsResult: {
  data: ModelStub[];
  isPending: boolean;
  isPlaceholderData: boolean;
} = { data: [OPENAI_MODEL], isPending: false, isPlaceholderData: false };

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: mockAvailableKeys }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => mockModelsResult,
}));

// Presentational stand-ins so the test drives selection deterministically
// without exercising the popover/searchable-select internals.
vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <div>{title}</div>
        <div>{description}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/components/llm-provider-api-key-dropdown", () => ({
  LlmProviderApiKeyDropdown: ({
    availableKeys,
    onSelectKey,
  }: {
    availableKeys: { id: string }[];
    onSelectKey: (value: string) => void;
  }) => (
    <div>
      {availableKeys.map((key) => (
        <button key={key.id} type="button" onClick={() => onSelectKey(key.id)}>
          select-key-{key.id}
        </button>
      ))}
    </div>
  ),
}));

// Renders one button per offered option so a test can assert exactly which
// models the picker exposes (a stale option would be a selectable button).
vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: ({
    options,
    onValueChange,
    disabled,
  }: {
    options: { value: string }[];
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <div data-disabled={disabled}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onValueChange(option.value)}
        >
          model-option-{option.value}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/organization.query");
vi.mock("@/lib/hooks/use-app-name");

import { useAppName } from "@/lib/hooks/use-app-name";
import { useUpdateAgentSettings } from "@/lib/organization.query";
import { DefaultModelOnboardingStep } from "./default-model-onboarding";

const mutateAsync = vi.fn();

function renderStep(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DefaultModelOnboardingStep onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAvailableKeys = [KEY];
  mockModelsResult = {
    data: [OPENAI_MODEL],
    isPending: false,
    isPlaceholderData: false,
  };
  // Success path returns the updated organization; the step closes only then.
  mutateAsync.mockResolvedValue({ id: "org-1" });

  vi.mocked(useAppName).mockReturnValue("Spark");
  vi.mocked(useUpdateAgentSettings).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateAgentSettings>);
});

describe("DefaultModelOnboardingStep", () => {
  it("shows the card first with the picker dialog closed", () => {
    renderStep();

    expect(screen.getByText("Set a default model")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose model" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Skip for now" }),
    ).toBeInTheDocument();
    // The picker only opens on demand — it does not appear over the card.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("writes the org default from the preselected key and picked model", async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    // The single available key is preselected, so the model can be picked
    // without choosing a key first.
    await user.click(screen.getByText("model-option-model-1"));
    await user.click(screen.getByRole("button", { name: "Set default" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      defaultModelId: "model-1",
      defaultLlmApiKeyId: "key-1",
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("does not offer the previous key's models while the new key is loading", async () => {
    const user = userEvent.setup();
    mockAvailableKeys = [KEY, ANTHROPIC_KEY];
    renderStep();

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    // key-1 (OpenAI) is preselected and its model is offered.
    expect(screen.getByText("model-option-model-1")).toBeInTheDocument();

    // Switch to the Anthropic key. `keepPreviousData` keeps serving the OpenAI
    // list (as placeholder) until the Anthropic fetch resolves — the picker
    // must not expose that stale model, or the admin could save an OpenAI model
    // against the Anthropic key.
    mockModelsResult = {
      data: [OPENAI_MODEL],
      isPending: false,
      isPlaceholderData: true,
    };
    await user.click(screen.getByText("select-key-key-2"));

    expect(screen.queryByText("model-option-model-1")).not.toBeInTheDocument();
  });

  it("advances to chat from the card without saving when skipped", async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("keeps the picker open and does not advance when saving fails", async () => {
    // The mutation resolves to null on error (it toasts instead of throwing).
    mutateAsync.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    const { onDone } = renderStep();

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    await user.click(screen.getByText("model-option-model-1"));
    await user.click(screen.getByRole("button", { name: "Set default" }));

    expect(mutateAsync).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("returns to the card (not chat) when the picker is dismissed", async () => {
    const user = userEvent.setup();
    const { onDone } = renderStep();

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Dialog closed, still on the onboarding card, onboarding not finished.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose model" }),
    ).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
