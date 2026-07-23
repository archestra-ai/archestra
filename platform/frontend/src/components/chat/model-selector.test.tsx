import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// The selector derives its Subscriptions group from the viewer's own keys.
// These tests cover model grouping and gating, so no key and no session is the
// right baseline: all three subscriptions read as "not connected".
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: [] }),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

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
    heading?: ReactNode;
  }) => (
    <div>
      {heading}
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

  // A ChatGPT-subscription agent/org default the viewer hasn't connected is
  // absent from their catalog by design. Even without the `suppressAutoSelect`
  // gate, the resolver must hold it (via the resolved subscription-provider
  // hint) rather than swap in the org key's model — that silently changes who
  // pays. This is the pure-resolver defense beneath `suppressAutoSelect`.
  it("does not auto-swap a subscription model absent from the viewer's list", () => {
    // No keys mocked -> the ChatGPT (openai) subscription reads as unconnected.
    setQuery({ modelsByProvider: { openai: [model()] } });
    const { onModelChange } = renderSelector({
      selectedModel: "sub-model-absent",
      fallbackModelProvider: "openai",
      variant: "default",
    });
    expect(onModelChange).not.toHaveBeenCalled();
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

  it("clears the selection without nesting a button inside the trigger button", () => {
    setQuery({ modelsByProvider: { openai: [model()] } });
    const onClear = vi.fn();
    renderSelector({ selectedModel: "m1", variant: "default", onClear });

    const clear = screen.getByLabelText("Clear model");
    // The trigger itself is a <button>; a nested real <button> is invalid HTML
    // and logs a hydration error (seen on Agents → Edit).
    expect(clear.tagName).not.toBe("BUTTON");
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
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

  // The sign-in rows start a personal device flow, so only chat opts in. In the
  // agent-config picker (no `showSubscriptions`) they must not appear, or an
  // admin editing an agent would connect their own account from inside it.
  describe("subscriptions group gating", () => {
    it("renders the Subscriptions sign-in rows when showSubscriptions is set", () => {
      setQuery({ modelsByProvider: { openai: [model()] } });
      renderSelector({
        selectedModel: "m1",
        variant: "default",
        showSubscriptions: true,
      });

      fireEvent.click(screen.getByTestId("dialog-toggle"));

      expect(screen.getByText("Subscriptions")).toBeInTheDocument();
      expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
      // One sign-in badge per unconnected subscription (all three here).
      expect(screen.getAllByText("Sign in")).toHaveLength(3);
    });

    it("hides the Subscriptions group without showSubscriptions", () => {
      setQuery({ modelsByProvider: { openai: [model()] } });
      renderSelector({ selectedModel: "m1", variant: "default" });

      fireEvent.click(screen.getByTestId("dialog-toggle"));

      expect(screen.queryByText("Subscriptions")).not.toBeInTheDocument();
      expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
    });
  });

  describe("current model outside the available list", () => {
    it("offers sign-in when the held model is backed by an unconnected subscription", () => {
      setQuery({ modelsByProvider: { openai: [model()] } });
      renderSelector({
        selectedModel: "pinned-id",
        suppressAutoSelect: true,
        fallbackModelName: "GPT-5 Codex",
        fallbackModelProvider: "openai",
        variant: "default",
      });

      fireEvent.click(screen.getByTestId("dialog-toggle"));

      expect(screen.getByText("Current (sign in to use)")).toBeInTheDocument();
      expect(
        screen.queryByText("Current (API key missing)"),
      ).not.toBeInTheDocument();
      // Trigger and dialog row both show the resolved name, never the model UUID.
      expect(screen.getAllByText("GPT-5 Codex")).toHaveLength(2);
      expect(screen.queryByText("pinned-id")).not.toBeInTheDocument();
    });

    it("keeps the key-missing marker when the held model is not subscription-backed", () => {
      setQuery({ modelsByProvider: { openai: [model()] } });
      renderSelector({
        selectedModel: "pinned-id",
        suppressAutoSelect: true,
        fallbackModelName: "Claude Opus",
        fallbackModelProvider: "anthropic",
        variant: "default",
      });

      fireEvent.click(screen.getByTestId("dialog-toggle"));

      expect(screen.getByText("Current (API key missing)")).toBeInTheDocument();
      expect(
        screen.queryByText("Current (sign in to use)"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("pinned-id")).not.toBeInTheDocument();
    });
  });
});
