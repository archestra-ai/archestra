import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationDefaultModelSummary } from "@/lib/organization.query";
import { CompanyConnectionPickers } from "./claude-connection-pickers";

const { keys, models } = vi.hoisted(() => ({
  keys: [
    {
      id: "key-anthropic",
      name: "Company Anthropic",
      provider: "anthropic",
      scope: "org",
      userId: null,
      teamName: null,
    },
    {
      id: "key-openai",
      name: "Company OpenAI",
      provider: "openai",
      scope: "org",
      userId: null,
      teamName: null,
    },
    {
      id: "key-subscription",
      name: "My Claude subscription",
      provider: "anthropic",
      scope: "personal",
      userId: "user-1",
      teamName: null,
      subscriptionKind: "claude",
    },
  ],
  models: [
    {
      dbId: "model-sonnet",
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      displayName: "Claude Sonnet 4.6",
      isBest: true,
      isFree: false,
      capabilities: { contextLength: 200_000 },
    },
    {
      dbId: "model-embed",
      id: "embed-1",
      provider: "anthropic",
      displayName: "Embedding model",
      isBest: false,
      isFree: false,
      capabilities: { contextLength: 8_000 },
    },
  ],
}));

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/lib/agent.query", () => ({
  useChatAgents: () => ({ data: [] }),
  useChatAgentPages: () => ({
    data: undefined,
    hasNextPage: false,
    isFetching: false,
    isError: false,
    fetchNextPage: vi.fn(),
  }),
  useChatAgentReferences: () => ({ data: [] }),
  usePinnedAgentIds: () => ({ data: [] }),
  useProfile: () => ({ data: undefined }),
  useAgentCredentialReadinessPages: () => ({ data: [] }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: models,
    isLoading: false,
    isPlaceholderData: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: keys }),
}));

vi.mock("@/lib/model-pools.query", () => ({
  useAvailableModelPools: () => ({ data: [] }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useUpdateConversation: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({
    label: (provider: string) => provider,
    isHidden: () => false,
    isKeyHidden: () => false,
    canAddKey: () => true,
  }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as never);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);
  vi.mocked(useOrganizationDefaultModelSummary).mockReturnValue({
    data: undefined,
  } as never);
});

function renderPickers(
  overrides: Partial<Parameters<typeof CompanyConnectionPickers>[0]> = {},
) {
  const props = {
    keys: keys as never,
    apiKeyId: "key-anthropic" as string | null,
    onApiKeyChange: vi.fn(),
    runsOn: (provider: string) => provider === "anthropic",
    modelId: "model-sonnet" as string | null,
    modelName: "Claude Sonnet 4.6" as string | null,
    modelProvider: "anthropic" as const,
    onModelChange: vi.fn(),
    claude: true,
    modelFilter: (model: { dbId: string }) => model.dbId !== "model-embed",
    onAddApiKey: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<CompanyConnectionPickers {...props} />);
  return { ...props, unmount };
}

describe("CompanyConnectionPickers", () => {
  it("names each field by its label and its value", () => {
    renderPickers();

    expect(
      screen.getByRole("button", {
        name: "Which connection pays Company Anthropic",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Model Claude Sonnet 4.6" }),
    ).toBeEnabled();
  });

  it("offers only the company connections that can run Claude and applies the choice", async () => {
    const user = userEvent.setup();
    const props = renderPickers({
      apiKeyId: null,
      modelId: null,
      modelName: null,
    });

    // No model can be picked before a connection.
    expect(
      screen.getByRole("button", { name: "Model Choose a connection first" }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", {
        name: "Which connection pays Choose a connection",
      }),
    );
    expect(
      screen.getByRole("option", { name: /Company Anthropic/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Company OpenAI/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /My Claude subscription/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Personal subscriptions"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Only keys that can run Claude are listed. 1 other is hidden.",
      ),
    ).toBeVisible();

    // This field chooses the connection only: no tabs, no models.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Claude Sonnet 4.6/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Company Anthropic/ }));
    expect(props.onApiKeyChange).toHaveBeenCalledWith("key-anthropic");
  });

  it("offers the connection's models the runtime can run and applies the choice", async () => {
    const user = userEvent.setup();
    const props = renderPickers({ modelId: null, modelName: null });

    await user.click(
      screen.getByRole("button", { name: "Model Select a Claude model" }),
    );
    // This field chooses the model only: no tabs, no connections.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Company Anthropic/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Embedding model/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Claude Sonnet 4.6/ }));
    expect(props.onModelChange).toHaveBeenCalledWith("model-sonnet");
  });

  it("adds a key from the connection menu", async () => {
    const user = userEvent.setup();
    const props = renderPickers();

    await user.click(
      screen.getByRole("button", { name: /^Which connection pays/ }),
    );
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    expect(props.onAddApiKey).toHaveBeenCalledOnce();
  });

  it("says what Claude needs when no connection can run it", async () => {
    const user = userEvent.setup();
    const props = renderPickers({
      apiKeyId: null,
      modelId: null,
      modelName: null,
      runsOn: () => false,
    });

    expect(screen.getByText("No connection here can run Claude")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Which connection pays/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add an Anthropic key" }),
    );
    expect(props.onAddApiKey).toHaveBeenCalledOnce();
  });

  it("speaks of the runtime, not of Claude, for an agent that does not run Claude Code", async () => {
    const user = userEvent.setup();
    const openAiOnly = {
      claude: false,
      runsOn: (provider: string) => provider === "openai",
      apiKeyId: "key-openai",
      modelId: null,
      modelName: null,
    };
    const listed = renderPickers(openAiOnly);

    expect(
      screen.getByRole("button", { name: "Model Select a model" }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole("button", {
        name: "Which connection pays Company OpenAI",
      }),
    );
    expect(
      screen.getByRole("option", { name: /Company OpenAI/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Company Anthropic/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Only keys this runtime can call are listed. 1 other is hidden.",
      ),
    ).toBeVisible();
    listed.unmount();

    const props = renderPickers({
      ...openAiOnly,
      apiKeyId: null,
      runsOn: () => false,
    });
    expect(
      screen.getByText("No connection here can run this agent"),
    ).toBeVisible();
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    expect(props.onAddApiKey).toHaveBeenCalledOnce();
  });

  it("does not present the agent's own personal subscription as the company connection", () => {
    // An agent that ran only on subscriptions stores its creator's own key.
    renderPickers({ apiKeyId: "key-subscription" });

    expect(
      screen.getByRole("button", {
        name: "Which connection pays Choose a connection",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByText("My Claude subscription"),
    ).not.toBeInTheDocument();
    // Its model is not the company connection's either.
    expect(
      screen.getByRole("button", { name: "Model Choose a connection first" }),
    ).toBeDisabled();
  });

  it("offers no clear control where the connection and model are required", () => {
    renderPickers();

    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
  });

  it("clears the model, or the connection, where they are optional", async () => {
    const user = userEvent.setup();
    const onApiKeyClear = vi.fn();
    const onModelClear = vi.fn();
    const first = renderPickers({ onApiKeyClear, onModelClear });

    // A control of its own beside each field: it does not open the list.
    await user.click(screen.getByRole("button", { name: "Clear model" }));
    expect(onModelClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole("option")).toBeNull();
    // Reached and used from the keyboard as well.
    screen.getByRole("button", { name: "Clear connection" }).focus();
    await user.keyboard("{Enter}");
    expect(onApiKeyClear).toHaveBeenCalledOnce();
    first.unmount();

    // Nothing is set, so there is nothing to clear.
    renderPickers({
      onApiKeyClear,
      onModelClear,
      apiKeyId: null,
      modelId: null,
      modelName: null,
    });
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
  });

  it("shows a connection and model set elsewhere by name, in disabled fields", () => {
    const locked = renderPickers({
      // The reader cannot read this connection: only its name is known.
      apiKeyId: "key-of-the-runtime",
      lockedConnection: { name: "Runtime connection" },
      modelLocked: true,
      modelName: "Runtime model",
      onApiKeyClear: vi.fn(),
      onModelClear: vi.fn(),
    });

    expect(
      screen.getByRole("button", {
        name: "Which connection pays Runtime connection",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Model Runtime model" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
    locked.unmount();

    // With only the connection set there, its model is still picked here.
    renderPickers({
      apiKeyId: "key-of-the-runtime",
      lockedConnection: { name: "Runtime connection" },
      modelId: null,
      modelName: null,
    });
    expect(
      screen.getByRole("button", {
        name: "Which connection pays Runtime connection",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Model Select a Claude model" }),
    ).toBeEnabled();
  });

  it("lists the models its caller gives, in place of the connection's own", async () => {
    const user = userEvent.setup();
    const props = renderPickers({
      // The reader cannot list this connection's models: its rule does.
      apiKeyId: "key-of-the-runtime",
      lockedConnection: { name: "Runtime connection" },
      modelId: null,
      modelName: null,
      models: [
        {
          dbId: "model-of-the-runtime",
          id: "claude-opus-4-6",
          provider: "anthropic",
          displayName: "Runtime Opus",
          isFree: false,
        },
      ],
    });

    await user.click(
      screen.getByRole("button", { name: "Model Select a Claude model" }),
    );
    expect(
      screen.queryByRole("option", { name: /Claude Sonnet 4.6/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Runtime Opus/ }));
    expect(props.onModelChange).toHaveBeenCalledWith("model-of-the-runtime");
  });

  it("names a connection the reader's list lacks by the name its caller gives", () => {
    renderPickers({
      apiKeyId: "key-of-another-team",
      apiKeyName: "Platform team Anthropic",
      onApiKeyClear: vi.fn(),
    });
    // It stays the reader's to change or clear.
    expect(
      screen.getByRole("button", {
        name: "Which connection pays Platform team Anthropic",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Clear connection" }),
    ).toBeInTheDocument();
  });

  it("leaves only the model to pick where the connection is decided elsewhere", async () => {
    const user = userEvent.setup();
    const fixed = { connectionFixed: true, modelId: null, modelName: null };
    const picked = renderPickers(fixed);

    expect(
      screen.queryByRole("button", { name: /^Which connection pays/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Model Select a Claude model" }),
    );
    await user.click(screen.getByRole("option", { name: /Claude Sonnet 4.6/ }));
    expect(picked.onModelChange).toHaveBeenCalledWith("model-sonnet");
    picked.unmount();

    // Even with no connection the runtime can call, there is none to add
    // here: the model waits for whoever decides the connection.
    renderPickers({ ...fixed, apiKeyId: null, runsOn: () => false });
    expect(
      screen.queryByText("No connection here can run Claude"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Model Choose a connection first" }),
    ).toBeDisabled();
  });
});
