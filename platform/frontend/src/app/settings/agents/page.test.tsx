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
let mockAgents: Array<{
  id: string;
  name: string;
  icon?: string | null;
  agentType: "agent";
  scope: "personal" | "team" | "org";
  authorEmail?: string | null;
}> = [];
let mockExecutionBackend: {
  name: "kubernetes";
  available: boolean;
  defaultImage: string;
  defaultTtlHours: number;
  defaultIdleTimeoutMinutes: number;
  allowPrivileged: boolean;
  resources: {
    cpuRequest: string;
    memoryRequest: string;
    memoryLimit: string;
  };
} | null = null;
const mockAgentSelector = vi.fn(
  ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <div>{value || placeholder}</div>
  ),
);

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
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      <div>{control}</div>
      {children}
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSaveBar: ({ hasChanges }: { hasChanges: boolean }) =>
    hasChanges ? <div>Unsaved changes</div> : null,
}));

vi.mock("@/components/agent-selector", () => ({
  AgentSelector: (props: Record<string, unknown>) =>
    mockAgentSelector(props as { value: string }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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

vi.mock("@/lib/config/config.query", () => ({
  useFeature: (feature: string) =>
    feature === "agentBackgroundExecutionBackend"
      ? mockExecutionBackend
      : undefined,
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: [
      {
        id: "gemini-2.5-pro",
        dbId: "gemini-2.5-pro",
        provider: "vertex_ai",
        displayName: "Gemini 2.5 Pro",
      },
    ],
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({
    data: mockApiKeys,
  }),
}));

const mutateAsync = vi.fn();

vi.mock("@/lib/organization.query");

import {
  useAppearanceSettings,
  useOrganization,
  useUpdateAgentSettings,
  useUpdateIntegrationSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

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
  vi.mocked(useUpdateIntegrationSettings).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateIntegrationSettings>);
  vi.clearAllMocks();
  mockOrganization = {
    defaultModelId: "gemini-2.5-pro",
    defaultLlmApiKeyId: "key-1",
    defaultAgentId: null,
    allowChatFileUploads: true,
    allowToolAutoAssignment: true,
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
  mockExecutionBackend = null;

  vi.mocked(useOrganization).mockReturnValue({
    data: mockOrganization,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: { appName: "Spark" },
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useUpdateAgentSettings).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateAgentSettings>);
  vi.mocked(useUpdateSecuritySettings).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSecuritySettings>);
});

describe("AgentSettingsPage", () => {
  it("shows the configured execution backend as a managed row only when enabled", () => {
    const { rerender } = renderPage();

    expect(
      screen.queryByRole("heading", { name: "Execution backend" }),
    ).not.toBeInTheDocument();

    mockExecutionBackend = {
      name: "kubernetes",
      available: true,
      defaultImage: "registry.example.test/agent:latest",
      defaultTtlHours: 72,
      defaultIdleTimeoutMinutes: 180,
      allowPrivileged: false,
      resources: {
        cpuRequest: "500m",
        memoryRequest: "1Gi",
        memoryLimit: "4Gi",
      },
    };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AgentSettingsPage />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Execution backend" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add backend" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit Kubernetes" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete Kubernetes" }),
    ).toBeDisabled();
    expect(
      screen.queryByText("registry.example.test/agent:latest"),
    ).not.toBeInTheDocument();

    const messagingChannels = screen.getByText("Available messaging channels");
    const executionBackend = screen.getByRole("heading", {
      name: "Execution backend",
    });
    expect(
      messagingChannels.compareDocumentPosition(executionBackend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lets users reset the org default model selection", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByText("Gemini 2.5 Pro")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(
      screen.getByText("Select provider key first..."),
    ).toBeInTheDocument();
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

  it("uses the shared agent selector for the default agent dropdown", () => {
    mockAgents = [
      {
        id: "agent-1",
        name: "Agent Builder Agent",
        icon: "🧰",
        agentType: "agent",
        scope: "org",
      },
    ];

    renderPage();

    const agentSelectorCall = mockAgentSelector.mock.calls.find(
      ([props]) =>
        (props as { searchPlaceholder?: string }).searchPlaceholder ===
        "Search agents...",
    );
    expect(agentSelectorCall).toBeDefined();

    const props = agentSelectorCall?.[0] as unknown as {
      mode: string;
      agents: typeof mockAgents;
      sentinelOption: { value: string; label: string };
    };

    expect(props.mode).toBe("single");
    expect(props.agents).toEqual(mockAgents);
    expect(props.sentinelOption).toMatchObject({
      value: "__personal__",
      label: "User's personal agent",
    });
  });
});
