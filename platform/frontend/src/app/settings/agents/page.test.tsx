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
const saveTiers = vi.fn();

vi.mock("@/lib/organization.query");

import {
  useAgentRuntimeTiers,
  useAppearanceSettings,
  useIsGlobalAdmin,
  useOrganization,
  useSaveAgentRuntimeTiers,
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
    isPending: false,
  } as unknown as ReturnType<typeof useAgentRuntimeTiers>);
  vi.mocked(useSaveAgentRuntimeTiers).mockReturnValue({
    mutateAsync: saveTiers,
    isPending: false,
  } as unknown as ReturnType<typeof useSaveAgentRuntimeTiers>);
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
  const block = () =>
    screen
      .getByRole("heading", { name: "Runtime tiers" })
      .closest("section") as HTMLElement;
  const rowOf = (name: string) =>
    within(block())
      .getByRole("button", { name: `Edit ${name}` })
      .closest("tr") as HTMLElement;
  const seedInput = {
    S: {
      name: "S",
      cpuRequest: 2,
      cpuLimit: null,
      pooled: true,
      workspaceGiB: null,
    },
    M: {
      name: "M",
      cpuRequest: 4,
      cpuLimit: null,
      pooled: true,
      workspaceGiB: null,
    },
    L: {
      name: "L",
      cpuRequest: 8,
      cpuLimit: null,
      pooled: false,
      workspaceGiB: null,
    },
  };

  it("lists the tiers smallest first with their memory, pools and default; the header links the docs and has no search or hint text", () => {
    enableRuntime();
    renderPage();

    expect(block()).toHaveTextContent(
      "Runtime tiers control compute and other resources allocation to agent runtimes.",
    );
    expect(
      within(block()).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/\/docs\/agents\/runtime\/setup#runtime-tiers$/),
    );
    expect(within(block()).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      within(block()).queryByPlaceholderText("Search tiers"),
    ).not.toBeInTheDocument();
    const names = within(block())
      .getAllByRole("button", { name: /^Edit / })
      .map((button) => button.getAttribute("aria-label")?.slice(5));
    expect(names).toEqual(["S", "M", "L"]);
    expect(rowOf("M")).toHaveTextContent("Default");
    expect(rowOf("S")).not.toHaveTextContent("Default");
    expect(rowOf("L")).toHaveTextContent("No limit");
    expect(rowOf("L")).toHaveTextContent("16 GiB32 GiB limit");
    // No size of its own: the deployment's volume, marked as the default.
    expect(rowOf("L")).toHaveTextContent("20 GiBdefault");
    expect(rowOf("S")).toHaveTextContent("Pooled");
    expect(rowOf("L")).not.toHaveTextContent("Pooled");
    expect(block()).not.toHaveTextContent("CPU request up to 8");
    expect(block()).not.toHaveTextContent("Ready spares");
    expect(
      within(block()).getByRole("button", { name: "Create tier" }),
    ).toBeVisible();
  });

  it("edits a tier in a dialog: a problem sits under its field, memory follows the CPU, and the whole list is saved", async () => {
    enableRuntime();
    saveTiers.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit L" }));
    const dialog = screen.getByRole("dialog", { name: "Edit tier" });
    const cpu = within(dialog).getByLabelText("CPU request");
    expect(cpu).toHaveValue(8);

    await user.clear(cpu);
    await user.type(cpu, "9");
    await user.tab();
    expect(
      within(dialog).getByText("Enter a number from 0.1 to 8"),
    ).toBeVisible();
    expect(cpu).toHaveAttribute("aria-invalid", "true");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(saveTiers).not.toHaveBeenCalled();

    await user.clear(cpu);
    await user.type(cpu, "6");
    expect(within(dialog).getByTestId("tier-memory")).toHaveTextContent(
      "Memory: 12 GiB, 24 GiB limit",
    );
    const limit = within(dialog).getByLabelText("CPU limit");
    await user.type(limit, "2");
    await user.tab();
    expect(
      within(dialog).getByText("The CPU limit is below the CPU request"),
    ).toBeVisible();
    await user.clear(limit);
    await user.type(limit, "7");
    expect(within(dialog).getByTestId("tier-memory")).toHaveTextContent(
      "Memory: 12 GiB, 14 GiB limit",
    );
    await user.type(within(dialog).getByLabelText("Workspace (GiB)"), "60");
    await user.click(within(dialog).getByRole("switch", { name: "Pooled" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(saveTiers).toHaveBeenCalledWith({
      tiers: [
        seedInput.S,
        seedInput.M,
        {
          name: "L",
          cpuRequest: 6,
          cpuLimit: 7,
          pooled: true,
          workspaceGiB: 60,
        },
      ],
      defaultTier: "M",
    });
  });

  it("renames the default tier and keeps it the default; a taken name is refused in the form", async () => {
    enableRuntime();
    saveTiers.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit M" }));
    const dialog = screen.getByRole("dialog", { name: "Edit tier" });
    const isDefault = within(dialog).getByRole("checkbox", {
      name: "Default tier",
    });
    expect(isDefault).toBeChecked();
    expect(isDefault).toBeDisabled();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "l");
    await user.tab();
    expect(within(dialog).getByText("Another tier is named l")).toBeVisible();
    await user.clear(name);
    await user.type(name, "Medium");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(saveTiers).toHaveBeenCalledWith({
      tiers: [
        seedInput.S,
        { ...seedInput.M, name: "Medium", previousName: "M" },
        seedInput.L,
      ],
      defaultTier: "Medium",
    });
  });

  it("creates a tier from the toolbar, as the default when asked", async () => {
    enableRuntime();
    saveTiers.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(block()).getByRole("button", { name: "Create tier" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Create tier" });
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(within(dialog).getByText("Enter a name")).toBeVisible();
    expect(saveTiers).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Name"), "XL");
    await user.type(within(dialog).getByLabelText("CPU request"), "8");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Default tier" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );

    expect(saveTiers).toHaveBeenCalledWith({
      tiers: [
        seedInput.S,
        seedInput.M,
        seedInput.L,
        {
          name: "XL",
          cpuRequest: 8,
          cpuLimit: null,
          pooled: true,
          workspaceGiB: null,
        },
      ],
      defaultTier: "XL",
    });
  });

  it("deletes a tier after a confirmation, never the default, and shows a refusal in the dialog", async () => {
    enableRuntime();
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByRole("button", { name: "Delete M" })).toBeDisabled();
    saveTiers.mockRejectedValueOnce(
      new Error(
        "Tier L is the default or scaleup tier of 1 agent; move them to another tier first",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Delete L" }));
    const dialog = screen.getByRole("dialog", { name: "Delete tier L?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Delete tier" }),
    );
    expect(saveTiers).toHaveBeenCalledWith({
      tiers: [seedInput.S, seedInput.M],
      defaultTier: "M",
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Tier L is the default or scaleup tier of 1 agent",
    );

    saveTiers.mockResolvedValueOnce({});
    await user.click(
      within(dialog).getByRole("button", { name: "Delete tier" }),
    );
    expect(saveTiers).toHaveBeenCalledTimes(2);
  });

  it("locks the table for anyone but an administrator", () => {
    enableRuntime();
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: false,
      isLoading: false,
    });
    renderPage();

    expect(
      within(block()).queryByRole("button", { name: "Create tier" }),
    ).not.toBeInTheDocument();
    expect(
      within(block()).queryByRole("button", { name: "Edit L" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Only administrators can change the tiers."),
    ).toBeVisible();
  });
});
