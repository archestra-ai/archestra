"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
let mockApiKeys: Array<{
  id: string;
  name: string;
  provider: string;
  scope: string;
}> = [];
let mockAgents: Array<{ id: string; name: string; icon?: string | null }> = [];
const mockSearchableSelect = vi.fn(
  ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <div>{value || placeholder}</div>
  ),
);
const { useInfiniteLlmModelsMock, fetchNextPageMock } = vi.hoisted(() => ({
  useInfiniteLlmModelsMock: vi.fn(),
  fetchNextPageMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/llm-provider-api-key-form", () => ({
  PROVIDER_CONFIG: {
    vertex_ai: {
      icon: "/vertex.svg",
      name: "Vertex AI",
    },
    openai: {
      icon: "/openai.svg",
      name: "OpenAI",
    },
    openrouter: {
      icon: "/openrouter.svg",
      name: "OpenRouter",
    },
  },
}));

vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: ({
    value,
    placeholder,
    disabled,
    freeFilterable,
    onSearchQueryChange,
    hasMore,
    isLoadingMore,
    onLoadMore,
    onValueChange,
  }: {
    value: string;
    placeholder: string;
    disabled?: boolean;
    freeFilterable?: boolean;
    onSearchQueryChange?: (value: string) => void;
    hasMore?: boolean;
    isLoadingMore?: boolean;
    onLoadMore?: () => void;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      <button type="button" disabled={disabled}>
        {value || placeholder}
      </button>
      {freeFilterable && <span>Free models only</span>}
      <button type="button" onClick={() => onValueChange("gpt-4o")}>
        Select gpt-4o
      </button>
      <button type="button" onClick={() => onSearchQueryChange?.("sonnet")}>
        Search sonnet
      </button>
      <button
        type="button"
        disabled={!hasMore || isLoadingMore}
        onClick={onLoadMore}
      >
        Load more models
      </button>
    </div>
  ),
}));

vi.mock("@/components/llm-provider-options", () => ({
  LlmProviderApiKeyOptionLabel: ({
    providerName,
    keyName,
  }: {
    providerName: string;
    keyName: string;
  }) => (
    <span>
      {providerName} {keyName}
    </span>
  ),
  LlmProviderApiKeySelectItems: () => null,
}));

vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (args: { hasPermission: boolean }) => React.ReactNode;
  }) => children({ hasPermission: true }),
}));

vi.mock("@/components/settings/settings-block", () => ({
  SettingsBlock: ({
    title,
    description,
    control,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      <div>{control}</div>
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSaveBar: ({
    hasChanges,
    disabledSave,
  }: {
    hasChanges: boolean;
    disabledSave?: boolean;
  }) =>
    hasChanges ? (
      <div>
        <div>Unsaved changes</div>
        <button type="button" disabled={disabledSave}>
          Save
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: (props: Record<string, unknown>) =>
    mockSearchableSelect(props as { value: string }),
}));

vi.mock("@/components/log-filter-option", () => ({
  ProfileFilterOption: ({ profile }: { profile: { name: string } }) => (
    <span>profile:{profile.name}</span>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div>
      {children}
      {(value === "" || value === "key-1") && onValueChange ? (
        <button type="button" onClick={() => onValueChange("key-1")}>
          Select key-1
        </button>
      ) : null}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({
    children,
    placeholder,
  }: {
    children?: React.ReactNode;
    placeholder?: string;
  }) => <span>{children ?? placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/agent.query", () => ({
  useOrgScopedAgents: () => ({
    data: mockAgents,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({
    data: mockApiKeys,
  }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useInfiniteLlmModels: useInfiniteLlmModelsMock,
}));

const mutateAsync = vi.fn();

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
  }),
  useAppearanceSettings: () => ({
    data: {
      appName: "Spark",
    },
  }),
  useUpdateAgentSettings: () => ({
    mutateAsync,
    isPending: false,
  }),
  useUpdateSecuritySettings: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

import AgentSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrganization = {
    defaultModelId: "gemini-2.5-pro",
    defaultLlmApiKeyId: "key-1",
    defaultAgentId: null,
    globalToolPolicy: "permissive",
    allowChatFileUploads: true,
  };
  mockApiKeys = [
    {
      id: "key-1",
      name: "gemini - org",
      provider: "vertex_ai",
      scope: "org",
    },
  ];
  mockAgents = [];
  fetchNextPageMock.mockResolvedValue(undefined);
  useInfiniteLlmModelsMock.mockReturnValue({
    models: [
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        provider: "vertex_ai",
      },
    ],
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: fetchNextPageMock,
  });
});

describe("AgentSettingsPage", () => {
  it("shows a disabled model selector placeholder until an API key is selected", () => {
    mockOrganization = {
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
      defaultAgentId: null,
      globalToolPolicy: "permissive",
      allowChatFileUploads: true,
    };

    renderPage();

    expect(screen.getByText("Select API key first")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select API key first" }),
    ).toBeDisabled();
  });

  it("lets users reset the org default model selection", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByText("Select API key first")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("hides the free-model filter for non-OpenRouter API keys", () => {
    renderPage();

    expect(screen.queryByText("Free models only")).not.toBeInTheDocument();
  });

  it("shows the free-model filter for OpenRouter API keys", () => {
    mockApiKeys = [
      {
        id: "key-1",
        name: "openrouter - org",
        provider: "openrouter",
        scope: "org",
      },
    ];

    renderPage();

    expect(screen.getByText("Free models only")).toBeInTheDocument();
  });

  it("does not expose a standalone model clear action", () => {
    renderPage();

    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear model" }),
    ).not.toBeInTheDocument();
  });

  it("keeps save disabled when an API key is selected without a model", async () => {
    const user = userEvent.setup();
    mockOrganization = {
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
      defaultAgentId: null,
      globalToolPolicy: "permissive",
      allowChatFileUploads: true,
    };

    renderPage();

    await user.click(
      screen.getAllByRole("button", { name: "Select key-1" })[0],
    );

    expect(screen.getByText("Select model...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables save after selecting a model for the selected API key", async () => {
    const user = userEvent.setup();
    mockOrganization = {
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
      defaultAgentId: null,
      globalToolPolicy: "permissive",
      allowChatFileUploads: true,
    };

    renderPage();

    await user.click(
      screen.getAllByRole("button", { name: "Select key-1" })[0],
    );
    await user.click(screen.getByRole("button", { name: "Select gpt-4o" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("passes search text to the infinite model query", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("button", { name: "Search sonnet" }));

    expect(useInfiniteLlmModelsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiKeyId: "key-1",
        q: "sonnet",
        limit: 50,
        enabled: true,
      }),
    );
  });

  it("loads more models when more pages are available", async () => {
    const user = userEvent.setup();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [],
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: fetchNextPageMock,
    });

    renderPage();

    await user.click(screen.getByRole("button", { name: "Load more models" }));

    expect(fetchNextPageMock).toHaveBeenCalledOnce();
  });

  it("does not load more models while a page is already fetching", async () => {
    const user = userEvent.setup();
    useInfiniteLlmModelsMock.mockReturnValue({
      models: [],
      hasNextPage: true,
      isFetchingNextPage: true,
      fetchNextPage: fetchNextPageMock,
    });

    renderPage();

    await user.click(screen.getByRole("button", { name: "Load more models" }));

    expect(fetchNextPageMock).not.toHaveBeenCalled();
  });

  it("uses the shared profile filter renderer for org agent rows in the default agent dropdown", () => {
    mockAgents = [
      {
        id: "agent-1",
        name: "Agent Builder Agent",
        icon: "🧰",
      },
    ];

    renderPage();

    const searchableSelectCall = mockSearchableSelect.mock.calls.find(
      ([props]) =>
        (props as { searchPlaceholder?: string }).searchPlaceholder ===
        "Search agents...",
    );
    expect(searchableSelectCall).toBeDefined();

    const items = (
      searchableSelectCall?.[0] as unknown as {
        items: Array<{
          value: string;
          label: string;
          content?: React.ReactNode;
          selectedContent?: React.ReactNode;
        }>;
      }
    ).items;

    expect(items[0]).toMatchObject({
      value: "__personal__",
      label: "User's personal agent",
    });
    expect(items[1]).toMatchObject({
      value: "agent-1",
      label: "Agent Builder Agent",
    });
    expect(items[1].content).toBeTruthy();
    expect(items[1].selectedContent).toBeTruthy();
  });
});
