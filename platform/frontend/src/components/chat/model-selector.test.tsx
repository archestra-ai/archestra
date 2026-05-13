import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ModelSelector } from "./model-selector";

const {
  useAvailableLlmModelMock,
  useInfiniteLlmModelsMock,
  useSyncLlmModelsMock,
} = vi.hoisted(() => ({
  useAvailableLlmModelMock: vi.fn(),
  useInfiniteLlmModelsMock: vi.fn(),
  useSyncLlmModelsMock: vi.fn(),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useAvailableLlmModel: useAvailableLlmModelMock,
  useInfiniteLlmModels: useInfiniteLlmModelsMock,
  useSyncLlmModels: useSyncLlmModelsMock,
}));

vi.mock("@/components/model-badges", () => ({
  UnknownCapabilitiesBadge: () => <span>Unknown capabilities</span>,
}));

let intersectionCallback: IntersectionObserverCallback | null = null;

const firstModel = {
  id: "gpt-4.1",
  displayName: "GPT 4.1",
  provider: "openai",
  capabilities: {
    inputModalities: ["text", "image"],
    supportsToolCalling: true,
    contextLength: 128000,
    pricePerMillionInput: "2.00",
    pricePerMillionOutput: "8.00",
  },
};

const secondModel = {
  id: "gpt-4.1-mini",
  displayName: "GPT 4.1 Mini",
  provider: "openai",
  capabilities: {
    inputModalities: ["text"],
    supportsToolCalling: false,
    contextLength: 64000,
    pricePerMillionInput: "0.20",
    pricePerMillionOutput: "0.80",
  },
};

describe("ModelSelector", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
    globalThis.IntersectionObserver = class IntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    } as unknown as typeof IntersectionObserver;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    intersectionCallback = null;
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });
    useAvailableLlmModelMock.mockImplementation(
      (params: { modelId?: string | null }) => ({
        data: params.modelId === firstModel.id ? firstModel : null,
        isFetched: true,
        isFetching: false,
      }),
    );
    useSyncLlmModelsMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not mount the searchable model list until opened", async () => {
    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    expect(screen.queryByPlaceholderText("Search models...")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(screen.getByPlaceholderText("Search models...")).toBeInTheDocument();
    expect(screen.getByText("(gpt-4.1)")).toBeInTheDocument();
  });

  it("provides an accessible dialog description", async () => {
    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(
      screen.getByText("Search and select an available language model."),
    ).toBeInTheDocument();
  });

  it("renders only the currently loaded page of models", async () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: true,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(screen.getByText("(gpt-4.1)")).toBeInTheDocument();
    expect(screen.queryByText("(gpt-4.1-mini)")).toBeNull();
  });

  it("does not show a loading trigger when the query is disabled", () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [],
      isPending: true,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector
        selectedModel=""
        onModelChange={vi.fn()}
        enabled={false}
      />,
    );

    expect(screen.queryByText("Loading models...")).toBeNull();
    expect(screen.getByText("No models available")).toBeInTheDocument();
  });

  it("shows the custom disabled empty label when provided", () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [],
      isPending: true,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector
        selectedModel=""
        onModelChange={vi.fn()}
        enabled={false}
        disabledEmptyLabel="Best available model"
        variant="outline"
      />,
    );

    expect(screen.queryByText("Loading models...")).toBeNull();
    expect(screen.queryByText("No models available")).toBeNull();
    expect(screen.getByText("Best available model")).toBeInTheDocument();
    expect(screen.getByTestId("chat-model-selector-trigger")).toBeDisabled();
  });

  it("auto-selects the best loaded model when no model is selected", () => {
    const onModelChange = vi.fn();
    const bestModel = { ...secondModel, isBest: true };
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel, bestModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(<ModelSelector selectedModel="" onModelChange={onModelChange} />);

    expect(onModelChange).toHaveBeenCalledWith(
      "gpt-4.1-mini",
      expect.objectContaining({ id: "gpt-4.1-mini", isBest: true }),
    );
  });

  it("auto-selects the first loaded model when no best model is present", () => {
    const onModelChange = vi.fn();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel, secondModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(<ModelSelector selectedModel="" onModelChange={onModelChange} />);

    expect(onModelChange).toHaveBeenCalledWith(
      "gpt-4.1",
      expect.objectContaining({ id: "gpt-4.1" }),
    );
  });

  it("selects a loaded model", async () => {
    const onModelChange = vi.fn();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel, secondModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={onModelChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));
    await userEvent.click(screen.getByText("GPT 4.1 Mini"));

    expect(onModelChange).toHaveBeenCalledWith(
      "gpt-4.1-mini",
      expect.objectContaining({ id: "gpt-4.1-mini" }),
    );
  });

  it("renders the clear action outside the model selector trigger", async () => {
    const onClear = vi.fn();

    render(
      <ModelSelector
        selectedModel="gpt-4.1"
        onModelChange={vi.fn()}
        onClear={onClear}
        enabled
      />,
    );

    const trigger = screen.getByTestId("chat-model-selector-trigger");
    const clearButton = screen.getByRole("button", { name: "Clear model" });

    expect(within(trigger).queryByRole("button")).toBeNull();

    await userEvent.click(clearButton);

    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByPlaceholderText("Search models...")).toBeNull();
  });

  it("sends debounced search and filter params to the query hook", async () => {
    vi.useFakeTimers();

    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    fireEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), {
      target: { value: "vision" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vision" }));
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(useInfiniteLlmModelsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        q: "vision",
        inputModalities: ["image"],
        supportsToolCalling: "true",
      }),
    );
  });

  it("sends the selected provider filter to the query hook", async () => {
    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));
    await userEvent.click(screen.getByRole("combobox", { name: /provider/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Anthropic" }),
    );

    expect(useInfiniteLlmModelsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "anthropic",
      }),
    );
  });

  it("hides the provider filter when the API key already scopes the provider", async () => {
    render(
      <ModelSelector
        selectedModel="gpt-4.1"
        onModelChange={vi.fn()}
        apiKeyId="key-1"
        enabled
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(
      screen.queryByRole("combobox", { name: /provider/i }),
    ).not.toBeInTheDocument();
  });

  it("fetches the next page when the bottom sentinel intersects", async () => {
    const fetchNextPage = vi.fn();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: true,
      fetchNextPage,
    });

    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));
    await waitFor(() => expect(intersectionCallback).toBeTruthy());
    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("does not replace a selected model that is outside the loaded page", () => {
    const onModelChange = vi.fn();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [secondModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: true,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector
        selectedModel="not-loaded-model"
        onModelChange={onModelChange}
        enabled
      />,
    );

    expect(
      screen.getByRole("button", { name: /not-loaded-model/i }),
    ).toBeInTheDocument();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("does not mark a backend-available selected model as API key missing when outside the loaded page", async () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [secondModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: true,
      fetchNextPage: vi.fn(),
    });
    useAvailableLlmModelMock.mockReturnValue({
      data: {
        ...secondModel,
        id: "not-loaded-model",
        displayName: "Not Loaded Model",
      },
      isFetched: true,
      isFetching: false,
    });

    render(
      <ModelSelector
        selectedModel="not-loaded-model"
        onModelChange={vi.fn()}
        enabled
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Not Loaded Model/i }),
    );

    expect(screen.getByRole("group", { name: "Current" })).toBeInTheDocument();
    expect(screen.queryByText("Current (API key missing)")).toBeNull();
  });

  it("marks the selected model as API key missing when backend availability check returns null", async () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [secondModel],
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });
    useAvailableLlmModelMock.mockReturnValue({
      data: null,
      isFetched: true,
      isFetching: false,
    });

    render(
      <ModelSelector
        selectedModel="missing-model"
        onModelChange={vi.fn()}
        enabled
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /missing-model/i }),
    );

    expect(screen.getByText("Current (API key missing)")).toBeInTheDocument();
  });

  it("keeps the selected model visible while selection is resolving", () => {
    render(
      <ModelSelector
        selectedModel="missing-model"
        onModelChange={vi.fn()}
        isResolvingSelection
      />,
    );

    const trigger = screen.getByTestId("chat-model-selector-trigger");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("missing-model");
    expect(trigger).not.toHaveTextContent("Resolving...");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText("Current (API key missing)")).toBeNull();
  });

  it("keeps previous results visible while updated filters load", async () => {
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [firstModel],
      isPending: false,
      isFetching: true,
      isFetchingNextPage: false,
      isPlaceholderData: true,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });

    render(
      <ModelSelector selectedModel="gpt-4.1" onModelChange={vi.fn()} enabled />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(screen.getByText("(gpt-4.1)")).toBeInTheDocument();
    expect(screen.getByText("Updating results...")).toBeInTheDocument();
    expect(screen.queryByText("End of results")).toBeNull();
  });
});
