import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/lib/organization.query";
import { ModelSelector } from "./model-selector";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const { useLlmModelsByProviderMock } = vi.hoisted(() => ({
  useLlmModelsByProviderMock: vi.fn(
    (): Record<string, unknown> => ({ modelsByProvider: {} }),
  ),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: useLlmModelsByProviderMock,
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: [] }),
}));

// The dropdown internals are Radix-based and irrelevant to the branches under
// test. The root mock exposes a toggle button wired to onOpenChange so tests
// can flip the component's open state, and structural wrappers render their
// children so the gating tests can observe what is mounted.
vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelector: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="dialog-toggle"
        onClick={() => onOpenChange?.(!open)}
      />
      {children}
    </div>
  ),
  ModelSelectorTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ModelSelectorContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  ModelSelectorList: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ModelSelectorEmpty: () => null,
  ModelSelectorGroup: ({
    children,
    heading,
  }: {
    children: ReactNode;
    heading?: string;
  }) => (
    <div data-testid="model-group" data-heading={heading}>
      {children}
    </div>
  ),
  ModelSelectorItem: ({ children }: { children: ReactNode }) => (
    <div data-testid="model-option">{children}</div>
  ),
  ModelSelectorInput: () => null,
  ModelSelectorLogo: () => null,
  ModelSelectorName: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

// The dialog body renders a DialogClose, which requires a real Radix Dialog
// ancestor — mocked away above, so stub it.
vi.mock("@/components/ui/dialog", () => ({
  DialogClose: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInputButton: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

type QueryShape = {
  modelsByProvider: Record<string, unknown[]>;
  isPending: boolean;
  isFetching: boolean;
  isLoading: boolean;
  isPlaceholderData: boolean;
};

function setQuery(overrides: Partial<QueryShape>) {
  useLlmModelsByProviderMock.mockReturnValue({
    modelsByProvider: {},
    isPending: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    ...overrides,
  });
}

const model = (over: Record<string, unknown> = {}) => ({
  dbId: "m1",
  id: "gpt-4o",
  displayName: "GPT-4o",
  provider: "openai",
  isBest: true,
  ...over,
});

function renderSelector(
  props: Partial<React.ComponentProps<typeof ModelSelector>> = {},
) {
  const onModelChange = vi.fn();
  render(
    <ModelSelector selectedModel="" onModelChange={onModelChange} {...props} />,
  );
  return { onModelChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  setQuery({});
});

vi.mock("@/lib/organization.query");

// The components under test resolve provider labels through
// useModelProviderCatalog() -> useOrganization(); no organization data means
// "no admin overrides", i.e. every provider visible under its built-in name.
beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
});

describe("clear control", () => {
  // The trigger is itself a <button>. A clear control nested inside it is
  // invalid HTML: React reports it, hydration breaks, and keyboard users
  // cannot reach it separately from the trigger.
  it.each([
    "outline",
    "default",
  ] as const)("renders the clear control outside the trigger button (%s variant)", (variant) => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({ selectedModel: "m1", onClear: vi.fn(), variant });

    const clear = screen.getByRole("button", { name: /clear model/i });
    expect(clear.parentElement?.closest("button")).toBeNull();
    expect(document.querySelector("button button")).toBeNull();
  });

  it("clears without opening the model dialog", () => {
    const onClear = vi.fn();
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({ selectedModel: "m1", onClear, variant: "outline" });

    fireEvent.click(screen.getByRole("button", { name: /clear model/i }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("dialog-content")).not.toBeInTheDocument();
  });

  it("does not offer the clear control while the selector is disabled", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({
      selectedModel: "m1",
      onClear: vi.fn(),
      variant: "outline",
      disabled: true,
    });

    expect(screen.getByRole("button", { name: /clear model/i })).toBeDisabled();
  });
});

describe("ModelSelector coverage matrix", () => {
  it("shows the loading spinner while a real fetch is in flight", () => {
    setQuery({ isPending: true, isFetching: true, isLoading: true });
    renderSelector({ variant: "default" });
    expect(screen.getByText("Loading models...")).toBeInTheDocument();
  });

  // A disabled query is `isPending` yet never fetches, so it must not render the
  // spinner; with no cached models it falls through to the empty state.
  it("does not spin forever for a disabled, never-fetching query", () => {
    setQuery({ isPending: true, isFetching: false, isLoading: false });
    renderSelector({ variant: "outline", enabled: false });
    expect(screen.queryByText("Loading models...")).not.toBeInTheDocument();
    expect(screen.getByText("No models available")).toBeInTheDocument();
  });

  it("renders the selected model's display name when it is available", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({ selectedModel: "m1", variant: "default" });
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
  });

  it("auto-selects the best model when the selected one is unavailable", async () => {
    setQuery({ modelsByProvider: { openai: [model({ isBest: true })] } });
    const { onModelChange } = renderSelector({
      selectedModel: "stale-id",
      variant: "default",
    });
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith("m1"));
  });

  // The org-wide GitHub Copilot catalog is flagged "best" but requires a
  // per-user connection the viewer lacks; auto-select must prefer their own
  // keyed model rather than silently defaulting to the unconnected provider.
  it("auto-selects a keyed model over an unconnected per-user 'best' model", async () => {
    setQuery({
      modelsByProvider: {
        "github-copilot": [
          model({
            dbId: "copilot-1",
            provider: "github-copilot",
            isBest: true,
            requiresUserConnection: true,
            isConnected: false,
          }),
        ],
        anthropic: [
          model({ dbId: "kimi-1", provider: "anthropic", isBest: false }),
        ],
      },
    });
    const { onModelChange } = renderSelector({
      selectedModel: "stale-id",
      variant: "default",
    });
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith("kimi-1"));
  });

  it("renders the empty-selection placeholder and does not auto-select", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    const { onModelChange } = renderSelector({
      selectedModel: "",
      variant: "outline",
    });
    expect(screen.getByText("Best available model")).toBeInTheDocument();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("renders 'No models available' when the query returns no models", () => {
    setQuery({ modelsByProvider: {} });
    renderSelector({ variant: "default" });
    expect(screen.getByText("No models available")).toBeInTheDocument();
  });

  it("does not auto-select while showing placeholder data", () => {
    setQuery({
      modelsByProvider: { openai: [model()] },
      isFetching: true,
      isPlaceholderData: true,
    });
    const { onModelChange } = renderSelector({
      selectedModel: "stale-id",
      variant: "default",
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  // The option tree is expensive with many models, and the toolbar rerenders
  // on unrelated state changes; a closed selector must not build the dialog
  // content at all (chat prompt typing froze when it did).
  it("does not mount the dialog option tree while closed", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({ selectedModel: "m1", variant: "default" });
    expect(screen.queryByTestId("dialog-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-option")).not.toBeInTheDocument();
  });

  it("mounts the option tree when opened and unmounts it again on close", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    renderSelector({ selectedModel: "m1", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(screen.getByTestId("dialog-content")).toBeInTheDocument();
    expect(screen.getAllByTestId("model-option").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(screen.queryByTestId("dialog-content")).not.toBeInTheDocument();
  });

  it("splits Perplexity into a chat-completions section above the Agent API one", () => {
    // One provider, two backing APIs: the picker must show which API each
    // model speaks, with the sonar chat-completions family listed first.
    setQuery({
      modelsByProvider: {
        perplexity: [
          model({
            dbId: "p1",
            id: "anthropic/claude-opus-5",
            isBest: false,
            capabilities: { supportsToolCalling: true },
          }),
          model({
            dbId: "p2",
            id: "sonar-pro",
            isBest: true,
            capabilities: {
              inputModalities: ["text"],
              supportsToolCalling: false,
            },
          }),
        ],
        openai: [model()],
      },
    });
    renderSelector({ selectedModel: "p2", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    const headings = screen
      .getAllByTestId("model-group")
      .map((group) => group.getAttribute("data-heading"))
      .filter((heading) => heading?.includes("Perplexity"));
    expect(headings).toEqual([
      "Perplexity AI — Chat Completions",
      "Perplexity AI — Agent API",
    ]);
    // The plain-provider group is untouched by the sectioning.
    expect(
      screen
        .getAllByTestId("model-group")
        .some((group) => group.getAttribute("data-heading") === "OpenAI"),
    ).toBe(true);
    // A recorded supportsToolCalling: false is known data — the row carries
    // the explicit tool-less marker, not the unknown-capabilities badge.
    expect(screen.getByText("Tool calling not supported")).toBeInTheDocument();
  });

  it("keeps the pinned model and shows the fallback name when auto-select is suppressed", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    const { onModelChange } = renderSelector({
      selectedModel: "pinned-id",
      suppressAutoSelect: true,
      fallbackModelName: "Pinned Model",
      variant: "default",
    });
    expect(screen.getByText("Pinned Model")).toBeInTheDocument();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  // Only Ollama rows get a verdict today, and they sync with an inferred "text"
  // modality and no tool-calling verdict — so this marker is the only thing
  // standing between such a row and an empty badge column.
  const ollamaRow = (capabilities: Record<string, unknown>) =>
    model({
      dbId: "o1",
      id: "qwen3:4b",
      displayName: "qwen3:4b",
      provider: "ollama",
      isBest: false,
      capabilities,
    });

  it("badges a flagged model in the picker list", () => {
    setQuery({
      modelsByProvider: {
        ollama: [
          ollamaRow({
            inputModalities: ["text"],
            recommendedForAgents: false,
          }),
        ],
      },
    });
    renderSelector({ selectedModel: "o1", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(screen.getByText("Limited for complex tasks")).toBeInTheDocument();
  });

  // `true` is the column default, so it says nothing and must stay silent —
  // there is no positive counterpart to this badge.
  it("shows nothing for a recommended model", () => {
    setQuery({
      modelsByProvider: {
        ollama: [
          ollamaRow({
            inputModalities: ["text"],
            recommendedForAgents: true,
          }),
        ],
      },
    });
    renderSelector({ selectedModel: "o1", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(
      screen.queryByText("Limited for complex tasks"),
    ).not.toBeInTheDocument();
  });

  // A null verdict means no sync evaluated the model; the row must make no
  // claim rather than assume either way.
  it("makes no claim when no verdict was recorded", () => {
    setQuery({
      modelsByProvider: {
        openai: [model({ capabilities: { inputModalities: ["text"] } })],
      },
    });
    renderSelector({ selectedModel: "m1", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(
      screen.queryByText("Limited for complex tasks"),
    ).not.toBeInTheDocument();
  });

  // The verdict is not capability data: a row carrying one and nothing else is
  // still a row whose capabilities were never recorded.
  it("still calls a verdict-only row's capabilities unknown", () => {
    setQuery({
      modelsByProvider: {
        ollama: [ollamaRow({ recommendedForAgents: false })],
      },
    });
    renderSelector({ selectedModel: "o1", variant: "default" });

    fireEvent.click(screen.getByTestId("dialog-toggle"));
    expect(screen.getByText("capabilities unknown")).toBeInTheDocument();
    expect(
      screen.queryByText("Limited for complex tasks"),
    ).not.toBeInTheDocument();
  });
});
