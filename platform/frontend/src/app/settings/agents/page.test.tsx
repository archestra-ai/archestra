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
  useAgentRuntimeTiers,
  useAppearanceSettings,
  useIsGlobalAdmin,
  useOrganization,
  useUpdateAgentSettings,
  useUpdateIntegrationSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { agentRuntimeTiersSeed } from "@/mocks/data/organization";
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
  vi.mocked(useAgentRuntimeTiers).mockReturnValue({
    data: agentRuntimeTiersSeed,
  } as unknown as ReturnType<typeof useAgentRuntimeTiers>);
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
    vi.mocked(useAgentRuntimeTiers).mockReturnValue({
      data: agentRuntimeTiersSeed,
    } as unknown as ReturnType<typeof useAgentRuntimeTiers>);
  };

  it("lists the tiers smallest first with the memory their CPU gives, and saves renames, new tiers and the default", async () => {
    enableRuntime();
    mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Runtime tiers" }),
    ).toBeVisible();
    const names = screen
      .getAllByRole("textbox", { name: /^Tier .* name$/ })
      .map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["S", "M", "L"]);
    expect(screen.getByLabelText("Tier L CPU request")).toHaveValue(8);
    expect(screen.getByLabelText("Tier L CPU limit")).toHaveAttribute(
      "placeholder",
      "No limit",
    );
    expect(screen.getByLabelText("Tier L ready spares")).toHaveValue(0);
    expect(screen.getByRole("radio", { name: "Default tier M" })).toBeChecked();
    const rowOf = (name: string) =>
      screen.getByLabelText(`Tier ${name} name`).closest("tr") as HTMLElement;
    expect(rowOf("L")).toHaveTextContent("16 GiB32 GiB limit");

    // Memory follows the CPU as it is typed.
    const cpu = screen.getByLabelText("Tier L CPU request");
    await user.clear(cpu);
    await user.type(cpu, "6");
    expect(rowOf("L")).toHaveTextContent("12 GiB24 GiB limit");
    await user.type(screen.getByLabelText("Tier L CPU limit"), "7");
    expect(rowOf("L")).toHaveTextContent("12 GiB14 GiB limit");

    // Rename S, add a tier, make it the default.
    const small = screen.getByLabelText("Tier S name");
    await user.clear(small);
    await user.type(small, "Small");
    await user.click(screen.getByRole("button", { name: "Add tier" }));
    await user.type(screen.getByLabelText("Tier new tier name"), "XL");
    await user.type(screen.getByLabelText("Tier XL CPU request"), "8");
    await user.click(screen.getByRole("radio", { name: "Default tier Small" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      agentRuntimeTiers: {
        tiers: [
          {
            name: "Small",
            cpuRequest: 2,
            cpuLimit: null,
            warmSpares: 1,
            previousName: "S",
          },
          { name: "M", cpuRequest: 4, cpuLimit: null, warmSpares: 1 },
          { name: "L", cpuRequest: 6, cpuLimit: 7, warmSpares: 0 },
          { name: "XL", cpuRequest: 8, cpuLimit: null, warmSpares: 0 },
        ],
        defaultTier: "Small",
      },
    });
  });

  it("names a value out of range or a missing name and keeps Save disabled", async () => {
    enableRuntime();
    const user = userEvent.setup();
    renderPage();
    const cpu = screen.getByLabelText("Tier L CPU request");

    await user.clear(cpu);
    await user.type(cpu, "9");
    expect(
      screen.getByRole("alert", { name: "Runtime tier problems" }),
    ).toHaveTextContent("Tier L: the CPU request is more than 0 and at most 8");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(cpu);
    await user.type(cpu, "4");
    await user.type(screen.getByLabelText("Tier L CPU limit"), "2");
    expect(
      screen.getByRole("alert", { name: "Runtime tier problems" }),
    ).toHaveTextContent("Tier L: the CPU limit is below the CPU request");

    await user.clear(screen.getByLabelText("Tier L CPU limit"));
    await user.clear(screen.getByLabelText("Tier M name"));
    expect(
      screen.getByRole("alert", { name: "Runtime tier problems" }),
    ).toHaveTextContent("Name every tier");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("removes a tier, moving the default when it was the default, and keeps at least one", async () => {
    enableRuntime();
    mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Remove tier M" }));
    expect(screen.queryByLabelText("Tier M name")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Default tier S" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Remove tier L" }));
    expect(
      screen.getByRole("button", { name: "Remove tier S" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      agentRuntimeTiers: {
        tiers: [{ name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 1 }],
        defaultTier: "S",
      },
    });
  });

  it("locks the fields for anyone but an administrator", () => {
    enableRuntime();
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: false,
      isLoading: false,
    });
    renderPage();

    expect(screen.getByLabelText("Tier L CPU request")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Add tier" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Only administrators can change the tiers."),
    ).toBeVisible();
  });
});
