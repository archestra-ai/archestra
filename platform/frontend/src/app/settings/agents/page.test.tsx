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
let mockRuntimeEnabled: boolean | undefined;
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
    notice,
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
    notice?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {notice ? <div>{notice}</div> : null}
      <div>{control}</div>
      {children}
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSaveBar: ({
    hasChanges,
    disabledSave,
    onSave,
  }: {
    hasChanges: boolean;
    disabledSave?: boolean;
    onSave: () => void;
  }) =>
    hasChanges ? (
      <div>
        Unsaved changes
        <button type="button" disabled={disabledSave} onClick={onSave}>
          Save
        </button>
      </div>
    ) : null,
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
    feature === "agentRuntimeBackend"
      ? mockRuntimeBackend
      : feature === "agentRuntime"
        ? mockRuntimeEnabled
        : undefined,
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: [
      {
        id: "gemini-2.5-pro",
        dbId: "gemini-2.5-pro",
        provider: "gemini",
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
  useIsGlobalAdmin,
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
    playwrightMcpEnabled: true,
    allowToolAutoAssignment: true,
  };
  mockApiKeys = [
    {
      id: "key-1",
      name: "gemini - org",
      provider: "gemini",
      scope: "org",
    },
  ];
  mockRuntimeBackend = null;
  mockRuntimeEnabled = undefined;

  vi.mocked(useIsGlobalAdmin).mockReturnValue({
    isGlobalAdmin: true,
    isLoading: false,
  });
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
  it("shows the configured runtime backend as a managed row only when enabled", () => {
    const { rerender } = renderPage();

    expect(
      screen.getByRole("heading", { name: "Agent Runtime Beta" }),
    ).toBeVisible();

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
        <AgentSettingsPage />
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

    const messagingChannels = screen.getByText("Available messaging channels");
    const runtimeBackend = screen.getByRole("heading", {
      name: "Runtime backend",
    });
    expect(
      messagingChannels.compareDocumentPosition(runtimeBackend) &
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

  it("offers fast and smart models only once the normal model is chosen", () => {
    mockOrganization = { ...mockOrganization, defaultModelId: null };
    vi.mocked(useOrganization).mockReturnValue({
      data: mockOrganization,
    } as unknown as ReturnType<typeof useOrganization>);

    renderPage();

    expect(screen.queryByText("Fast model")).not.toBeInTheDocument();
    expect(screen.queryByText("Smart model")).not.toBeInTheDocument();
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

describe("Runtime tiers", () => {
  const enableRuntime = () => {
    mockRuntimeEnabled = true;
    mockRuntimeBackend = {
      name: "kubernetes",
      available: true,
      defaultTtlHours: 24,
      defaultIdleTimeoutMinutes: 60,
      allowPrivileged: false,
      resources: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
    };
  };

  it("shows the defaults as placeholders and saves only the fields an administrator filled in", async () => {
    enableRuntime();
    mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Runtime tiers" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Tier L CPU request")).toHaveAttribute(
      "placeholder",
      "8",
    );
    expect(screen.getByLabelText("Tier L Memory limit")).toHaveAttribute(
      "placeholder",
      "32Gi",
    );
    expect(screen.getByLabelText("Tier L Warm spares")).toHaveAttribute(
      "placeholder",
      "0",
    );
    expect(screen.getByLabelText("Tier M Warm spares")).toHaveAttribute(
      "placeholder",
      "Deployment",
    );
    expect(screen.getByLabelText("Tier S CPU limit")).toHaveAttribute(
      "placeholder",
      "No limit",
    );

    await user.type(screen.getByLabelText("Tier L CPU request"), "6");
    await user.type(screen.getByLabelText("Tier L Warm spares"), "1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      agentRuntimeTiers: { L: { cpuRequest: "6", warmPoolSize: 1 } },
    });
  });

  it("names an invalid value or a tier out of order and keeps Save disabled", async () => {
    enableRuntime();
    const user = userEvent.setup();
    renderPage();
    const cpu = screen.getByLabelText("Tier L CPU request");

    await user.type(cpu, "4 cores");
    expect(
      screen.getByRole("alert", { name: "Runtime tier problems" }),
    ).toHaveTextContent(
      "Tier L CPU request: enter a CPU amount such as 2 or 500m",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(cpu);
    await user.type(cpu, "1");
    expect(
      screen.getByRole("alert", { name: "Runtime tier problems" }),
    ).toHaveTextContent("Tier L requests less than tier M");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows the saved values and locks the fields for anyone but an administrator", () => {
    enableRuntime();
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        ...mockOrganization,
        agentRuntimeTiers: { L: { memoryLimit: "24Gi" } },
      },
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: false,
      isLoading: false,
    });
    renderPage();

    const memoryLimit = screen.getByLabelText("Tier L Memory limit");
    expect(memoryLimit).toHaveValue("24Gi");
    expect(memoryLimit).toBeDisabled();
    expect(
      screen.getByText("Only administrators can change the tiers."),
    ).toBeVisible();
  });
});
