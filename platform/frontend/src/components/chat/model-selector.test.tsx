import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// The dropdown internals are Radix-based and irrelevant to the branches under
// test; render only the trigger so assertions target the visible button text.
vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelector: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ModelSelectorTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ModelSelectorContent: () => null,
  ModelSelectorList: () => null,
  ModelSelectorEmpty: () => null,
  ModelSelectorGroup: () => null,
  ModelSelectorItem: () => null,
  ModelSelectorInput: () => null,
  ModelSelectorLogo: () => null,
  ModelSelectorName: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
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
});
