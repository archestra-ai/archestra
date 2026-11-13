"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
let mockApiKeys: Array<{
  id: string;
  name: string;
  provider: string;
  scope: string;
}> = [];
let mockRuntimeBackend: {
  name: "kubernetes";
  available: boolean;
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

vi.mock("@/components/settings/runtime-template-section", () => ({
  RuntimeTemplateSection: () => <div>Runtime templates</div>,
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

vi.mock("@/lib/config/config.query", () => ({
  useFeature: (feature: string) =>
    feature === "agentRuntimeBackend" ? mockRuntimeBackend : undefined,
}));

let mockModels: Array<Record<string, unknown>> = [];

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({ data: mockModels, isPending: false }),
}));

vi.mock("@/lib/agent.query", () => ({
  useUpdateAgentModels: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  useDefaultModelRuntimeDependents,
  useOrganization,
  useUpdateAgentSettings,
  useUpdateIntegrationSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { AgentRuntimeSettings } from "./_parts/agent-runtime-settings";
import AgentSettingsPage from "./page";

function renderRuntimesPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentRuntimeSettings />
    </QueryClientProvider>,
  );
}

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
  mockRuntimeBackend = null;
  mockModels = [
    {
      id: "gemini-2.5-pro",
      dbId: "gemini-2.5-pro",
      provider: "vertex_ai",
      displayName: "Gemini 2.5 Pro",
    },
  ];

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
  vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
    data: { agents: [], hiddenBlockingCount: 0 },
  } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);
});

describe("AgentSettingsPage", () => {
  it("shows the configured runtime backend as a managed row below the runtime templates, only when enabled", () => {
    const { rerender } = renderRuntimesPage();

    expect(screen.getByText("Runtime templates")).toBeVisible();

    expect(
      screen.queryByRole("heading", { name: "Runtime backend" }),
    ).not.toBeInTheDocument();

    mockRuntimeBackend = {
      name: "kubernetes",
      available: true,
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
        <AgentRuntimeSettings />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Runtime backend" }),
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

    const runtimeTemplates = screen.getByText("Runtime templates");
    const runtimeBackend = screen.getByRole("heading", {
      name: "Runtime backend",
    });
    expect(
      runtimeTemplates.compareDocumentPosition(runtimeBackend) &
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
});

describe("Default model blocked by Agent Runtime agents", () => {
  it("names the Claude Code agents that can't run the default and opens a dialog offering only keys they can use", async () => {
    const user = userEvent.setup();
    mockApiKeys = [
      { id: "key-1", name: "gemini - org", provider: "gemini", scope: "org" },
      {
        id: "key-2",
        name: "anthropic - org",
        provider: "anthropic",
        scope: "org",
      },
    ];
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: {
        hiddenBlockingCount: 0,
        agents: [
          {
            id: "agent-1",
            name: "Release Notes Writer",
            canUpdate: true,
            runtimeCommand: ["archestra-claude-code"],
            inferenceProtocol: "anthropic",
            claudeCodeAuthentication: "provider",
          },
        ],
      },
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    renderPage();

    await user.click(
      screen.getByRole("button", { name: "1 agent can't run this" }),
    );
    expect(
      screen.getByText("Can't make Gemini 2.5 Pro the default"),
    ).toBeVisible();
    expect(screen.getByText("Release Notes Writer")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Set model" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Set a model for Release Notes Writer",
    });
    // Claude Code can't use the Gemini key, so only the Anthropic key is offered.
    expect(within(dialog).getByText("anthropic - org")).toBeVisible();
    expect(within(dialog).queryByText("gemini - org")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("counts a Responses-only model as blocking an agent whose runtime uses Chat Completions", async () => {
    mockOrganization = { ...mockOrganization, defaultModelId: "copilot-1" };
    vi.mocked(useOrganization).mockReturnValue({
      data: mockOrganization,
    } as unknown as ReturnType<typeof useOrganization>);
    mockApiKeys = [
      {
        id: "key-1",
        name: "copilot",
        provider: "github-copilot",
        scope: "org",
      },
    ];
    mockModels = [
      {
        id: "gpt-5.1-codex",
        dbId: "copilot-1",
        provider: "github-copilot",
        displayName: "GPT-5.1 Codex",
        capabilities: { supportedEndpoints: ["/responses"] },
      },
    ];
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: {
        hiddenBlockingCount: 0,
        agents: [
          {
            id: "agent-1",
            name: "Chat Completions Agent",
            runtimeCommand: null,
            inferenceProtocol: "openai_chat",
          },
        ],
      },
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: "1 agent can't run this" }),
    );
    expect(screen.getByText(/requires the Responses API/)).toBeVisible();
  });

  it("does not count a Claude Code agent on subscription authentication, which runs on the person's Claude account instead", () => {
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: {
        hiddenBlockingCount: 0,
        agents: [
          {
            id: "agent-1",
            name: "Release Notes Writer",
            runtimeCommand: ["archestra-claude-code"],
            inferenceProtocol: "anthropic",
          },
        ],
      },
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    renderPage();

    expect(
      screen.queryByRole("button", { name: /can't run this/ }),
    ).not.toBeInTheDocument();
  });

  it("counts blocking agents the viewer can't read, without saying anything about them", async () => {
    const user = userEvent.setup();
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: { agents: [], hiddenBlockingCount: 2 },
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    renderPage();

    await user.click(
      screen.getByRole("button", { name: "2 agents can't run this" }),
    );
    expect(screen.getByText("2 agents you can't view")).toBeVisible();
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it("offers no Set model action for an agent the viewer can't update", async () => {
    const user = userEvent.setup();
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: {
        hiddenBlockingCount: 0,
        agents: [
          {
            id: "agent-read-only",
            name: "Read-only agent",
            canUpdate: false,
            runtimeCommand: ["archestra-claude-code"],
            inferenceProtocol: "anthropic",
            claudeCodeAuthentication: "provider",
          },
        ],
      },
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    renderPage();

    await user.click(
      screen.getByRole("button", { name: "1 agent can't run this" }),
    );
    expect(screen.getByText("Ask an agent admin")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Set model" }),
    ).not.toBeInTheDocument();
  });

  it("shows no warning when every runtime agent can run the default", () => {
    renderPage();

    expect(
      screen.queryByRole("button", { name: /can't run this/ }),
    ).not.toBeInTheDocument();
  });
});
