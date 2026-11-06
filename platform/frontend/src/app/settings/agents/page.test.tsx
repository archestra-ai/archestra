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
const saveTiers = vi.fn();

vi.mock("@/lib/organization.query");

import {
  useAgentRuntimeTiers,
  useAppearanceSettings,
  useDefaultModelRuntimeDependents,
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
  mockModels = [
    {
      id: "gemini-2.5-pro",
      dbId: "gemini-2.5-pro",
      provider: "gemini",
      displayName: "Gemini 2.5 Pro",
    },
  ];

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
  vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);
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
      data: [
        {
          id: "agent-1",
          name: "Release Notes Writer",
          canUpdate: true,
          runtimeCommand: ["archestra-claude-code"],
          inferenceProtocol: "anthropic",
          claudeCodeAuthentication: "provider",
        },
      ],
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
      data: [
        {
          id: "agent-1",
          name: "Chat Completions Agent",
          runtimeCommand: null,
          inferenceProtocol: "openai_chat",
        },
      ],
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
      data: [
        {
          id: "agent-1",
          name: "Release Notes Writer",
          runtimeCommand: ["archestra-claude-code"],
          inferenceProtocol: "anthropic",
        },
      ],
    } as unknown as ReturnType<typeof useDefaultModelRuntimeDependents>);

    renderPage();

    expect(
      screen.queryByRole("button", { name: /can't run this/ }),
    ).not.toBeInTheDocument();
  });

  it("offers no Set model action for an agent the viewer can't update", async () => {
    const user = userEvent.setup();
    vi.mocked(useDefaultModelRuntimeDependents).mockReturnValue({
      data: [
        {
          id: "agent-read-only",
          name: "Read-only agent",
          canUpdate: false,
          runtimeCommand: ["archestra-claude-code"],
          inferenceProtocol: "anthropic",
          claudeCodeAuthentication: "provider",
        },
      ],
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

  it("lists the tiers smallest first with their memory, pools and default; the header links the docs and explains pools, with no search or hint text", async () => {
    enableRuntime();
    const user = userEvent.setup();
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
    // The Pools header explains itself; nobody opens a dialog to read it.
    await user.hover(
      within(block()).getByRole("button", { name: "About pooled tiers" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "About pooled tiers" }),
    ).toHaveTextContent(
      "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity. Learn more",
    );
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
    await user.type(cpu, "257");
    await user.tab();
    expect(
      within(dialog).getByText("Enter a number from 0.1 to 256"),
    ).toBeVisible();
    expect(cpu).toHaveAttribute("aria-invalid", "true");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(saveTiers).not.toHaveBeenCalled();

    await user.clear(cpu);
    await user.type(cpu, "6");
    expect(
      within(dialog).getByLabelText("Memory request (GiB)"),
    ).toHaveAttribute("placeholder", "12");
    expect(within(dialog).getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "24",
    );
    const limit = within(dialog).getByLabelText("CPU limit");
    await user.type(limit, "2");
    await user.tab();
    expect(
      within(dialog).getByText("The CPU limit is below the CPU request"),
    ).toBeVisible();
    await user.clear(limit);
    await user.type(limit, "7");
    expect(within(dialog).getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "24",
    );
    await user.type(within(dialog).getByLabelText("Disk (GiB)"), "60");
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
          memoryRequestMiB: null,
          memoryLimitMiB: null,
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
        {
          ...seedInput.M,
          name: "Medium",
          previousName: "M",
          memoryRequestMiB: null,
          memoryLimitMiB: null,
        },
        seedInput.L,
      ],
      defaultTier: "Medium",
    });
  });

  it("keeps edit validation stable during the dialog exit animation", async () => {
    // jsdom has no live computed styles. Model the browser's exit animation
    // so Radix keeps the real dialog mounted after its open state changes.
    const computedStyle = window.getComputedStyle.bind(window);
    const styles = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) => {
        const result = computedStyle(element, pseudo);
        if (element.getAttribute("role") === "dialog")
          Object.defineProperty(result, "animationName", {
            get: () =>
              element.getAttribute("data-state") === "closed"
                ? "dialog-exit"
                : "none",
          });
        return result;
      });
    try {
      enableRuntime();
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole("button", { name: "Edit L" }));
      const dialog = screen.getByRole("dialog", { name: "Edit tier" });
      const name = within(dialog).getByLabelText("Name");
      await user.click(name);
      await user.tab();
      await user.keyboard("{Escape}");
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute("data-state", "closed");
      expect(within(dialog).getByText("Edit tier")).toBeInTheDocument();
      expect(name).not.toHaveAttribute("aria-invalid", "true");
      expect(dialog).not.toHaveTextContent("Another tier is named");
    } finally {
      styles.mockRestore();
    }
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
    await user.type(within(dialog).getByLabelText("CPU request"), "0");
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(within(dialog).queryByText("Enter a name")).not.toBeInTheDocument();
    expect(saveTiers).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Name"), "XL");
    await user.clear(within(dialog).getByLabelText("CPU request"));
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
          memoryRequestMiB: null,
          memoryLimitMiB: null,
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
