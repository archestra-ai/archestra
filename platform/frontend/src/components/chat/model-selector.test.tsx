import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
  useInfiniteLlmModelsByProviderMock,
  useSyncLlmModelsMock,
} = vi.hoisted(() => ({
  useAvailableLlmModelMock: vi.fn(),
  useInfiniteLlmModelsByProviderMock: vi.fn(),
  useSyncLlmModelsMock: vi.fn(),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useAvailableLlmModel: useAvailableLlmModelMock,
  useInfiniteLlmModelsByProvider: useInfiniteLlmModelsByProviderMock,
  useSyncLlmModels: useSyncLlmModelsMock,
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
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.IntersectionObserver = class IntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    intersectionCallback = null;
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [firstModel],
      modelsByProvider: {
        openai: [firstModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });
    useAvailableLlmModelMock.mockImplementation(
      (params: { modelId?: string | null }) => ({
        data: params.modelId === firstModel.id ? firstModel : null,
        isFetched: true,
        isFetching: false,
        isPlaceholderData: false,
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
    expect(useInfiniteLlmModelsByProviderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    await userEvent.click(screen.getByRole("button", { name: /GPT 4\.1/i }));

    expect(useInfiniteLlmModelsByProviderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByPlaceholderText("Search models...")).toBeInTheDocument();
    expect(screen.getByText("(gpt-4.1)")).toBeInTheDocument();
  });

  it("renders only the currently loaded page of models", async () => {
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [firstModel],
      modelsByProvider: {
        openai: [firstModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
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

  it("passes the selected model provider to the change handler", async () => {
    const onModelChange = vi.fn();

    render(
      <ModelSelector
        selectedModel="different-model"
        onModelChange={onModelChange}
        enabled
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /different-model/i }),
    );
    await userEvent.click(screen.getByText("(gpt-4.1)"));

    expect(onModelChange).toHaveBeenCalledWith("gpt-4.1", "openai");
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

    expect(useInfiniteLlmModelsByProviderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        q: "vision",
        inputModalities: ["image"],
        supportsToolCalling: "true",
      }),
    );
  });

  it("fetches the next page when the bottom sentinel intersects", async () => {
    const fetchNextPage = vi.fn();
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [firstModel],
      modelsByProvider: {
        openai: [firstModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
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
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [secondModel],
      modelsByProvider: {
        openai: [secondModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
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
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [secondModel],
      modelsByProvider: {
        openai: [secondModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
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
      isPlaceholderData: false,
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
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [secondModel],
      modelsByProvider: {
        openai: [secondModel],
      },
      isPending: false,
      isFetching: false,
      isFetchingNextPage: false,
      isFetched: true,
      isPlaceholderData: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    });
    useAvailableLlmModelMock.mockReturnValue({
      data: null,
      isFetched: true,
      isFetching: false,
      isPlaceholderData: false,
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

  it("keeps previous results visible while updated filters load", async () => {
    useInfiniteLlmModelsByProviderMock.mockReturnValue({
      models: [firstModel],
      modelsByProvider: {
        openai: [firstModel],
      },
      isPending: false,
      isFetching: true,
      isFetchingNextPage: false,
      isFetched: true,
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
