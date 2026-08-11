import { BUILT_IN_AGENT_IDS, E2eTestId } from "@archestra/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useEnterpriseFeature,
  useFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentDialog } from "./agent-dialog";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const {
  pendingSaveChanges,
  useAvailableLlmProviderApiKeysMock,
  useAgentDelegationsMock,
  useAgentSubagentExclusionsMock,
  useAgentSkillsMock,
  useAgentSkillExclusionsMock,
  useUpdateAgentSkillsMock,
  useUpdateAgentSkillExclusionsMock,
  useDelegationTargetAgentsMock,
  useLlmModelsByProviderMock,
  useProfileMock,
  useSkillsPaginatedMock,
  useSyncAgentDelegationsMock,
  useUpdateAgentSubagentExclusionsMock,
  useUpdateProfileMock,
  useCreateProfileMock,
  useDeleteProfileMock,
} = vi.hoisted(() => ({
  pendingSaveChanges: vi.fn(
    () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ),
  useDelegationTargetAgentsMock: vi.fn((): { data: unknown[] } => ({
    data: [],
  })),
  useProfileMock: vi.fn(
    (): { data: unknown | null; refetch: ReturnType<typeof vi.fn> } => ({
      data: null,
      refetch: vi.fn(),
    }),
  ),
  useAvailableLlmProviderApiKeysMock: vi.fn(() => ({ data: [] })),
  useLlmModelsByProviderMock: vi.fn(() => ({ modelsByProvider: {} })),
  useUpdateProfileMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useCreateProfileMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useDeleteProfileMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useAgentDelegationsMock: vi.fn(
    (): { data: unknown[]; isSuccess: boolean } => ({
      data: [],
      isSuccess: true,
    }),
  ),
  useSyncAgentDelegationsMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useAgentSubagentExclusionsMock: vi.fn(
    (): { data: { excludedSubagentIds: string[] }; isSuccess: boolean } => ({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    }),
  ),
  useUpdateAgentSubagentExclusionsMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useAgentSkillsMock: vi.fn(
    (): {
      data:
        | {
            accessAllSkills: boolean;
            skillIds: string[];
            skills: Array<Record<string, unknown>>;
          }
        | undefined;
      isSuccess: boolean;
      isError?: boolean;
    } => ({
      data: { accessAllSkills: false, skillIds: [], skills: [] },
      isSuccess: true,
    }),
  ),
  useAgentSkillExclusionsMock: vi.fn(
    (): {
      data:
        | {
            excludedSkillIds: string[];
            skills: Array<Record<string, unknown>>;
          }
        | undefined;
      isSuccess: boolean;
      isError?: boolean;
    } => ({
      data: { excludedSkillIds: [], skills: [] },
      isSuccess: true,
    }),
  ),
  useSkillsPaginatedMock: vi.fn(
    (
      _params: { search?: string },
      _options?: { enabled?: boolean },
    ): {
      data: { data: Array<Record<string, unknown>> };
      isFetching: boolean;
    } => ({ data: { data: [] }, isFetching: false }),
  ),
  useUpdateAgentSkillsMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useUpdateAgentSkillExclusionsMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => ({ data: [] }),
  };
});

vi.mock("@/lib/agent.query", () => ({
  useCreateProfile: useCreateProfileMock,
  useDeleteProfile: useDeleteProfileMock,
  useDelegationTargetAgents: useDelegationTargetAgentsMock,
  useProfile: useProfileMock,
  useUpdateProfile: useUpdateProfileMock,
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: useAgentDelegationsMock,
  useSyncAgentDelegations: useSyncAgentDelegationsMock,
}));

vi.mock("@/lib/agent-subagent-exclusions.query", () => ({
  useAgentSubagentExclusions: useAgentSubagentExclusionsMock,
  useUpdateAgentSubagentExclusions: useUpdateAgentSubagentExclusionsMock,
}));

vi.mock("@/lib/agent-skills.query", () => ({
  useAgentSkills: useAgentSkillsMock,
  useAgentSkillExclusions: useAgentSkillExclusionsMock,
  useUpdateAgentSkills: useUpdateAgentSkillsMock,
  useUpdateAgentSkillExclusions: useUpdateAgentSkillExclusionsMock,
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: useSkillsPaginatedMock,
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/chat/chat.query", () => ({
  useChatProfileMcpTools: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => ({ data: [] }),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => ({ data: [] }),
  useIsKnowledgeBaseConfigured: () => true,
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: useLlmModelsByProviderMock,
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: useAvailableLlmProviderApiKeysMock,
}));

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/docs/docs", () => ({
  getFrontendDocsUrl: () => "/docs",
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: false,
    },
  },
}));

vi.mock("@/components/agent-tools-editor", () => ({
  AgentToolsEditor: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      saveChanges: pendingSaveChanges,
    }));

    return <div>Mock Tools Editor</div>;
  }),
}));

vi.mock("@/components/agent-tool-exclusions-editor", () => ({
  AgentToolExclusionsEditor: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      saveChanges: vi.fn(),
    }));

    return <div>Mock Tool Exclusions Editor</div>;
  }),
}));

vi.mock("@/components/agent-labels", () => ({
  ProfileLabels: () => null,
}));

vi.mock("@/components/agent-badge", () => ({
  AgentBadge: () => null,
}));

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => null,
}));

vi.mock("@/components/chat/model-selector", () => ({
  ModelSelector: () => null,
}));

vi.mock("@/components/external-docs-link", () => ({
  ExternalDocsLink: () => null,
}));

vi.mock("@/components/permission-requirement-hint", () => ({
  PermissionRequirementHint: () => null,
  formatPermissionRequirement: () => "",
}));

vi.mock("@/components/system-prompt-editor", () => ({
  SystemPromptEditor: () => null,
}));

vi.mock("@/components/share-personal-credentials-dialog", () => ({
  SharePersonalCredentialsDialog: () => null,
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/environment-selector", () => ({
  EnvironmentSelector: ({ disabled }: { disabled?: boolean }) => (
    <div
      data-testid="environment-selector"
      data-disabled={disabled ? "true" : "false"}
    />
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDescription: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Functional rather than a stub: the picked-row memory under test only shows
// itself across a change of search query, which needs a real search field and
// selectable options. Options are labelled "Add <name>" so a chip's plain name
// stays a single match for getByText.
vi.mock("@/components/ui/assignment-combobox", () => ({
  AssignmentCombobox: ({
    items,
    onToggle,
    onSearchChange,
    placeholder,
    isSearching,
  }: {
    items: Array<{ id: string; name: string }>;
    onToggle: (id: string) => void;
    onSearchChange?: (query: string) => void;
    placeholder?: string;
    isSearching?: boolean;
  }) => (
    <div>
      <input
        aria-label={placeholder ?? "Search"}
        onChange={(e) => onSearchChange?.(e.target.value)}
      />
      {isSearching && <span>Searching…</span>}
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => onToggle(item.id)}>
          {`Add ${item.name}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandEmpty: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandInput: () => null,
  CommandItem: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandList: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogForm: ({
    children,
    onSubmit,
  }: {
    children?: React.ReactNode;
    onSubmit?: React.FormEventHandler<HTMLFormElement>;
  }) => <form onSubmit={onSubmit}>{children}</form>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogStickyFooter: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
}));

vi.mock("@/components/ui/expandable-text", () => ({
  ExpandableText: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/multi-select-combobox", () => ({
  MultiSelectCombobox: () => null,
}));

vi.mock("@/components/ui/overlapped-icons", () => ({
  OverlappedIcons: () => null,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
}));

vi.mock("@/components/ui/switch", () => ({
  // A real checkbox rather than null: the advisor toggle's checked state is
  // the behaviour under test, and a stub renders it unassertable.
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...props}
    />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

beforeEach(() => {
  vi.mocked(useFeature).mockReturnValue(
    false as unknown as ReturnType<typeof useFeature>,
  );
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  vi.mocked(useSmallTeamTier).mockReturnValue(undefined);
  vi.mocked(useAppName).mockReturnValue("Archestra");
});

const baseAgent = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000010",
  name: "Existing Agent",
  builtIn: false,
  icon: null,
  description: null,
  systemPrompt: null,
  agentType: "agent" as const,
  toolExposureMode: "full" as const,
  accessAllTools: false,
  accessAllSubagents: false,
  accessAllSkills: false,
  scope: "personal" as const,
  isDefault: false,
  isPersonalGateway: false,
  isPersonalProxy: false,
  teams: [],
  tools: [],
  labels: [],
  authorId: "00000000-0000-4000-8000-000000000020",
  authorName: "Test User",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  knowledgeBaseIds: [],
  connectorIds: [],
  suggestedPrompts: [],
  llmApiKeyId: null,
  llmModel: null,
  modelId: null,
  considerContextUntrusted: false,
  identityProviderId: null,
  environmentId: null,
  builtInAgentConfig: null,
  passthroughHeaders: null,
  incomingEmailEnabled: false,
  incomingEmailSecurityMode: "public" as const,
  incomingEmailAllowedDomain: null,
  slug: null,
  latestVersion: 0,
};

const targetAgent = {
  ...baseAgent,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Target Agent",
};

const advisorAgent = {
  ...baseAgent,
  id: "00000000-0000-4000-8000-000000000003",
  name: "Advisor",
  builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
};

// The Tools section carries its own Auto/Custom tabs, so the subagent ones have
// to be reached through their section.
const subagentModeTab = (name: "Auto" | "Custom") => {
  const section = screen
    .getByRole("heading", { name: "Subagents" })
    .closest("div") as HTMLElement;
  return within(section).getByRole("tab", { name });
};

describe("AgentDialog delegation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call data but keeps implementations; re-assert the
    // fast (immediate) tool-editor save so the save flow isn't gated on the
    // hoisted 50ms default, which makes the save-path assertions flaky.
    pendingSaveChanges.mockResolvedValue(undefined);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    useProfileMock.mockReturnValue({ data: null, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    useAgentDelegationsMock.mockReturnValue({
      data: [targetAgent],
      isSuccess: true,
    });
  });

  it("turns the advisor on in Custom mode by adding it as a subagent", async () => {
    const user = userEvent.setup();
    useProfileMock.mockReturnValue({
      data: { ...baseAgent, accessAllSubagents: false },
      refetch: vi.fn(),
    });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={{ ...baseAgent, accessAllSubagents: false }}
      />,
    );

    const toggle = await screen.findByTestId(E2eTestId.ConsultAdvisorSwitch);
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
    });
  });

  it("renders no environment selector for the advisor", async () => {
    // The advisor is configured once for the whole organization and reachable
    // from every environment, so there is no environment to show or move.
    const advisorBuiltIn = {
      ...baseAgent,
      id: advisorAgent.id,
      name: "Advisor",
      builtIn: true,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
    };
    useProfileMock.mockReturnValue({ data: advisorBuiltIn, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [advisorAgent] });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={advisorBuiltIn}
      />,
    );

    await screen.findByRole("heading", { name: "Edit Advisor" });
    expect(screen.queryByTestId("environment-selector")).toBeNull();
  });

  it("keeps the advisor out of the subagent lists, so only its switch offers it", async () => {
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [advisorAgent.id] },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={autoAgent}
      />,
    );

    // The switch is the single place the advisor is offered; listing it as a
    // disabled subagent as well would mean two controls for one decision.
    await waitFor(() => {
      expect(
        screen.getByTestId(E2eTestId.ConsultAdvisorSwitch),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(advisorAgent.name)).not.toBeInTheDocument();
    expect(screen.getByText(/Disabled subagents \(0\)/)).toBeInTheDocument();
  });

  it("reads as on in Auto mode only while the advisor is not disabled", async () => {
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    // Auto mode reaches every accessible agent, so the advisor being absent
    // from the disabled set is what "on" means there.
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={autoAgent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
    });
  });

  it("reads as off in Auto mode while the advisor sits in the disabled set", async () => {
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [advisorAgent.id] },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={autoAgent}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(E2eTestId.ConsultAdvisorSwitch),
      ).not.toBeChecked();
    });
  });

  it("keeps the advisor on when the subagent mode switches from Auto to Custom", async () => {
    const user = userEvent.setup();
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });
    // Custom mode's list holds no advisor, so reading it after the switch is
    // what would drop a setting the administrator never touched.
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={autoAgent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
    });

    await user.click(subagentModeTab("Custom"));

    // The panel assertion is what proves the mode actually moved; the switch
    // reading the same way afterwards is only meaningful once it has.
    expect(
      screen.getByText(/Only the subagents you assign below/),
    ).toBeInTheDocument();
    expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
  });

  it("keeps the advisor off when the subagent mode switches from Custom to Auto", async () => {
    const user = userEvent.setup();
    const customAgent = { ...baseAgent, accessAllSubagents: false };
    useProfileMock.mockReturnValue({ data: customAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
    // Auto mode reaches everything it does not exclude, so an empty exclusion
    // set would otherwise turn the advisor on the moment the mode changes.
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={customAgent}
      />,
    );

    const toggle = await screen.findByTestId(E2eTestId.ConsultAdvisorSwitch);
    expect(toggle).not.toBeChecked();

    await user.click(subagentModeTab("Auto"));

    expect(screen.getByText(/Disabled subagents \(0\)/)).toBeInTheDocument();
    expect(
      screen.getByTestId(E2eTestId.ConsultAdvisorSwitch),
    ).not.toBeChecked();
  });

  it("keeps an existing advisor grant on save for an agent in a named environment", async () => {
    const user = userEvent.setup();
    const syncDelegations = vi
      .fn()
      .mockResolvedValue({ added: [], removed: [] });
    const updateAgent = vi.fn();
    // The advisor row is org-wide (env-less); the agent sits in a named
    // environment and still holds a live grant on it, which reads as the
    // switch being on and survives the save untouched.
    const customAgent = {
      ...baseAgent,
      accessAllSubagents: false,
      environmentId: "00000000-0000-4000-8000-0000000000ff",
    };
    updateAgent.mockResolvedValue(customAgent);
    useProfileMock.mockReturnValue({ data: customAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentDelegationsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
      isSuccess: true,
    });
    useSyncAgentDelegationsMock.mockReturnValue({
      mutateAsync: syncDelegations,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={customAgent}
      />,
    );

    const toggle = await screen.findByTestId(E2eTestId.ConsultAdvisorSwitch);
    expect(toggle).toBeChecked();
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    // The saved grant set is unchanged — no scrub, so no delegation resync.
    expect(syncDelegations).not.toHaveBeenCalled();
  });

  it("saves no advisor grant when the switch ends up off after a trip through Custom", async () => {
    const user = userEvent.setup();
    const syncDelegations = vi
      .fn()
      .mockResolvedValue({ added: [], removed: [] });
    const syncExclusions = vi.fn().mockResolvedValue(undefined);
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, advisorAgent],
    });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });
    useSyncAgentDelegationsMock.mockReturnValue({
      mutateAsync: syncDelegations,
      isPending: false,
    });
    useUpdateAgentSubagentExclusionsMock.mockReturnValue({
      mutateAsync: syncExclusions,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue(autoAgent),
      isPending: false,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={autoAgent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
    });
    await user.click(subagentModeTab("Custom"));
    await user.click(subagentModeTab("Auto"));
    await user.click(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch));
    expect(
      screen.getByTestId(E2eTestId.ConsultAdvisorSwitch),
    ).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: /update/i }));

    // Both sets are written on save regardless of mode, and system or token
    // flows resolve targets from the delegation set even in Auto — so a grant
    // surviving here is a consultation the switch says is off.
    await waitFor(() => expect(syncExclusions).toHaveBeenCalled());
    expect(syncExclusions).toHaveBeenCalledWith(
      expect.objectContaining({
        exclusions: { excludedSubagentIds: [advisorAgent.id] },
      }),
    );
    for (const call of syncDelegations.mock.calls) {
      expect(call[0].targetAgentIds).not.toContain(advisorAgent.id);
    }
  });

  it("skips the delegation and subagent-exclusion syncs when neither set changed on save", async () => {
    const user = userEvent.setup();
    const syncDelegations = vi
      .fn()
      .mockResolvedValue({ added: [], removed: [] });
    const syncExclusions = vi.fn().mockResolvedValue(undefined);
    const updateAgent = vi.fn().mockResolvedValue(baseAgent);
    useSyncAgentDelegationsMock.mockReturnValue({
      mutateAsync: syncDelegations,
      isPending: false,
    });
    useUpdateAgentSubagentExclusionsMock.mockReturnValue({
      mutateAsync: syncExclusions,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });
    const onOpenChange = vi.fn();

    render(
      <AgentDialog
        open={true}
        onOpenChange={onOpenChange}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByText("Subagents (1)");
    await user.click(screen.getByRole("button", { name: /update/i }));

    // The save must complete (reaches the success close) and persist the agent —
    // proving the handler ran through the sync block, not that it bailed early.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateAgent).toHaveBeenCalled();
    // No delegation/exclusion changes → no redundant sync writes (each of which
    // would produce a spurious no-op agent.updated audit record).
    expect(syncDelegations).not.toHaveBeenCalled();
    expect(syncExclusions).not.toHaveBeenCalled();
  });

  it("syncs delegations when a subagent is removed before save", async () => {
    const user = userEvent.setup();
    const syncDelegations = vi
      .fn()
      .mockResolvedValue({ added: [], removed: [] });
    const updateAgent = vi.fn().mockResolvedValue(baseAgent);
    useSyncAgentDelegationsMock.mockReturnValue({
      mutateAsync: syncDelegations,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByText("Subagents (1)");
    await user.click(screen.getByRole("button", { name: /remove agent/i }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(
      () =>
        expect(syncDelegations).toHaveBeenCalledWith({
          agentId: baseAgent.id,
          targetAgentIds: [],
        }),
      { timeout: 3000 },
    );
  });

  it("renders a chip for an assigned skill the catalog page does not contain", async () => {
    // `useSkillsPaginated` is capped at 100 rows, so an assignment beyond that
    // page is absent from it. Drawing the picker from that page alone hid such
    // a skill entirely: the count said one, no chip appeared, and there was no
    // way to unpublish it. The assignment endpoint returns the row for exactly
    // this reason.
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "mcpGatewaySkillsEnabled") as unknown as typeof useFeature,
    );
    useAgentSkillsMock.mockReturnValue({
      data: {
        accessAllSkills: false,
        skillIds: ["00000000-0000-4000-8000-0000000000ff"],
        skills: [
          {
            id: "00000000-0000-4000-8000-0000000000ff",
            name: "off-page-skill",
            description: "beyond the first catalog page",
            scope: "org",
            templated: false,
            agentName: null,
            authorId: null,
          },
        ],
      },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    expect(await screen.findByText("off-page-skill")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove off-page-skill" }),
    ).toBeInTheDocument();
  });

  it("renders a chip for an excluded skill that has since left org scope", async () => {
    // Nothing prunes an exclusion when the skill it names is re-scoped, so the
    // id outlives the scope it was made under. Filtering the picker to org
    // scope alone stranded it: the count said one, no chip appeared, and the id
    // was re-submitted verbatim on every save with no way to drop it.
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "mcpGatewaySkillsEnabled") as unknown as typeof useFeature,
    );
    useAgentSkillsMock.mockReturnValue({
      data: { accessAllSkills: true, skillIds: [], skills: [] },
      isSuccess: true,
    });
    useAgentSkillExclusionsMock.mockReturnValue({
      data: {
        excludedSkillIds: ["00000000-0000-4000-8000-0000000000fe"],
        skills: [
          {
            id: "00000000-0000-4000-8000-0000000000fe",
            name: "regraded-skill",
            description: "excluded while org-scoped, since moved to a team",
            scope: "team",
            templated: false,
            agentName: null,
            authorId: null,
          },
        ],
      },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    expect(await screen.findByText("regraded-skill")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove regraded-skill" }),
    ).toBeInTheDocument();
  });

  it("keeps selected subagents when fresh agent data refetches", async () => {
    const { rerender } = render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByText("Subagents (1)");

    useProfileMock.mockReturnValue({
      data: { ...baseAgent, description: "Refetched description" },
      refetch: vi.fn(),
    });

    rerender(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Subagents (1)")).toBeInTheDocument();
    });
  });
});

const orgSkill = (name: string, id: string) => ({
  id,
  name,
  description: `the ${name} skill`,
  scope: "org" as const,
  templated: false,
  agentName: null,
  authorId: null,
  environments: [],
});

// The Tools and Subagents sections carry their own Auto/Custom tabs, so the
// skill ones have to be reached through their section.
const skillsModeTab = (name: "Auto" | "Custom") => {
  const section = screen
    .getByRole("heading", { name: "Published skills" })
    .closest("div") as HTMLElement;
  return within(section).getByRole("tab", { name });
};

describe("AgentDialog published skills", () => {
  const syncSkills = vi.fn();
  const syncSkillExclusions = vi.fn();
  const updateAgent = vi.fn();
  const createAgent = vi.fn();
  const deleteAgent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    createAgent.mockResolvedValue({ id: "created-agent", name: "New Agent" });
    deleteAgent.mockResolvedValue(undefined);
    useCreateProfileMock.mockReturnValue({
      mutateAsync: createAgent,
      isPending: false,
    });
    useDeleteProfileMock.mockReturnValue({
      mutateAsync: deleteAgent,
      isPending: false,
    });
    pendingSaveChanges.mockResolvedValue(undefined);
    syncSkills.mockResolvedValue(undefined);
    syncSkillExclusions.mockResolvedValue(undefined);
    updateAgent.mockResolvedValue(baseAgent);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    // Only this flag: the section does not exist without it.
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "mcpGatewaySkillsEnabled") as unknown as typeof useFeature,
    );
    useProfileMock.mockReturnValue({ data: null, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [] });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });
    useAgentSkillsMock.mockReturnValue({
      data: { accessAllSkills: false, skillIds: [], skills: [] },
      isSuccess: true,
    });
    useAgentSkillExclusionsMock.mockReturnValue({
      data: { excludedSkillIds: [], skills: [] },
      isSuccess: true,
    });
    useSkillsPaginatedMock.mockImplementation(() => ({
      data: { data: [] },
      isFetching: false,
    }));
    useUpdateAgentSkillsMock.mockReturnValue({
      mutateAsync: syncSkills,
      isPending: false,
    });
    useUpdateAgentSkillExclusionsMock.mockReturnValue({
      mutateAsync: syncSkillExclusions,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });
  });

  it("leaves the editors unseeded and writes nothing when the read fails", async () => {
    // A failed read used to be indistinguishable from a gateway that publishes
    // nothing: the editors seeded `Custom / Skills (0)` from the empty default,
    // and the next save wrote that back over an Auto-mode gateway that had been
    // publishing every organization skill.
    const user = userEvent.setup();
    useAgentSkillsMock.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
    });
    useAgentSkillExclusionsMock.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
    });
    const onOpenChange = vi.fn();

    render(
      <AgentDialog
        open={true}
        onOpenChange={onOpenChange}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    expect(
      await screen.findByText(/could not load the published skills/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Skills \(/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateAgent).toHaveBeenCalled();
    expect(syncSkills).not.toHaveBeenCalled();
    expect(syncSkillExclusions).not.toHaveBeenCalled();
  });

  it("hides the section from a caller who cannot read skills", async () => {
    // `skill:read` is the API's floor on these endpoints, so without it the
    // reads 403 and a save would too. Hiding the control is the difference
    // between one the caller never sees and one that fails when they use it.
    vi.mocked(useHasPermissions).mockImplementation(((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      return { data: !("skill" in permissions) };
    }) as unknown as typeof useHasPermissions);

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByRole("button", { name: /update/i });
    expect(screen.queryByText(/published skills/i)).not.toBeInTheDocument();
    expect(useAgentSkillsMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps the chip for a skill picked from a search once the query moves on", async () => {
    // The picker's rows are one catalog page plus the hits for the query being
    // typed, so a skill picked from one search belongs to neither afterwards.
    // Its chip used to vanish while its id stayed selected and was still
    // submitted — publishing something no one could see or remove.
    const user = userEvent.setup();
    const farAway = orgSkill(
      "far-away-skill",
      "00000000-0000-4000-8000-0000000000aa",
    );
    useSkillsPaginatedMock.mockImplementation((params) =>
      params.search === "far-away"
        ? { data: { data: [farAway] }, isFetching: false }
        : { data: { data: [] }, isFetching: false },
    );

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    const search = await screen.findByLabelText("Search skills...");
    await user.type(search, "far-away");
    await user.click(
      await screen.findByRole("button", { name: "Add far-away-skill" }),
    );
    expect(
      screen.getByRole("button", { name: "Remove far-away-skill" }),
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "something-else");

    // Waiting on the widened query proves the search page has actually moved
    // off the row; the chip surviving that is the behaviour under test.
    await waitFor(() =>
      expect(useSkillsPaginatedMock).toHaveBeenCalledWith(
        expect.objectContaining({ search: "something-else" }),
        expect.anything(),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove far-away-skill" }),
    ).toBeInTheDocument();
  });

  it("writes neither skill set when the save changed nothing about them", async () => {
    // Re-sending an unchanged set produces a spurious no-op audit record.
    const user = userEvent.setup();
    const assigned = orgSkill(
      "already-published",
      "00000000-0000-4000-8000-0000000000ab",
    );
    useAgentSkillsMock.mockReturnValue({
      data: {
        accessAllSkills: false,
        skillIds: [assigned.id],
        skills: [assigned],
      },
      isSuccess: true,
    });
    const onOpenChange = vi.fn();

    render(
      <AgentDialog
        open={true}
        onOpenChange={onOpenChange}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByText("Skills (1)");
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateAgent).toHaveBeenCalled();
    expect(syncSkills).not.toHaveBeenCalled();
    expect(syncSkillExclusions).not.toHaveBeenCalled();
  });

  it("writes the assignment set when the mode flips from Auto to Custom", async () => {
    // The Auto toggle rides on the assignment PUT, so a mode change with no
    // change of ids is still a change worth persisting.
    const user = userEvent.setup();
    useAgentSkillsMock.mockReturnValue({
      data: { accessAllSkills: true, skillIds: [], skills: [] },
      isSuccess: true,
    });

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    await screen.findByText(/Excluded skills \(0\)/);
    await user.click(skillsModeTab("Custom"));
    expect(screen.getByText("Skills (0)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(syncSkills).toHaveBeenCalled());
    expect(syncSkills).toHaveBeenCalledWith({
      agentId: baseAgent.id,
      assignments: { accessAllSkills: false, skillIds: [] },
    });
    expect(syncSkillExclusions).not.toHaveBeenCalled();
  });

  it("deletes the agent it just created when the skills write rejects", async () => {
    // Create mode publishes after the agent exists, so the write can fail with
    // an agent already created. It has to run before `onCreated` — both call
    // sites close the dialog from there — or the rejection lands on a screen
    // that has already said "created", leaving a half-configured gateway
    // behind. Inside the rollback, it deletes the agent instead.
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    syncSkills.mockRejectedValue(new Error("published skills rejected"));
    useSkillsPaginatedMock.mockImplementation(() => ({
      data: {
        data: [orgSkill("payroll", "00000000-0000-4000-8000-0000000000bb")],
      },
      isFetching: false,
    }));

    render(
      <AgentDialog
        open={true}
        onOpenChange={onOpenChange}
        agentType="agent"
        onCreated={onCreated}
      />,
    );

    const name = await screen.findByPlaceholderText(/name/i);
    await user.type(name, "New Agent");
    await user.click(skillsModeTab("Custom"));
    await user.click(
      await screen.findByRole("button", { name: "Add payroll" }),
    );
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(deleteAgent).toHaveBeenCalledWith("created-agent"),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("reads nothing while the dialog is closed", () => {
    // The component stays mounted with open={false} on the list and chat
    // pages, so a query enabled on `showSkills` alone fetched a skill catalog
    // on every one of those page loads, for a dialog nobody opened.
    render(
      <AgentDialog
        open={false}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    expect(useAgentSkillsMock).toHaveBeenCalledWith(undefined);
    expect(useAgentSkillExclusionsMock).toHaveBeenCalledWith(undefined);
    for (const call of useSkillsPaginatedMock.mock.calls) {
      expect(call[1]).toMatchObject({ enabled: false });
    }
  });

  it("keeps the open dialog on its agent when the agent leaves the caller's list", async () => {
    // Callers derive `agent` from a refetching list query, not from dialog
    // state. When the agent dropped out of that list mid-edit, the instance key
    // fell back to "new" and remounted the body as an empty create form —
    // silently discarding the edit, with the next save creating a new agent.
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={baseAgent}
      />,
    );

    const name = await screen.findByDisplayValue("Existing Agent");
    await user.clear(name);
    await user.type(name, "Renamed Agent");

    rerender(
      <AgentDialog open={true} onOpenChange={vi.fn()} agentType="agent" />,
    );

    expect(screen.getByDisplayValue("Renamed Agent")).toBeInTheDocument();
  });
});

describe.skip("AgentDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("does not eagerly enable agent-only queries for a closed MCP gateway dialog", () => {
    render(
      <AgentDialog
        open={false}
        onOpenChange={vi.fn()}
        agentType="mcp_gateway"
      />,
    );

    expect(useDelegationTargetAgentsMock).toHaveBeenCalledWith({
      enabled: false,
    });
    expect(useAvailableLlmProviderApiKeysMock).toHaveBeenCalledWith({
      includeKeyId: undefined,
      enabled: false,
    });
    expect(useLlmModelsByProviderMock).toHaveBeenCalledWith({
      enabled: false,
    });
  });

  it("disables Update immediately while save starts", async () => {
    const user = userEvent.setup();

    render(
      <AgentDialog
        open={true}
        onOpenChange={vi.fn()}
        agentType="agent"
        agent={{
          id: "agent-1",
          organizationId: "org-1",
          name: "Existing Agent",
          builtIn: false,
          icon: null,
          description: null,
          systemPrompt: null,
          agentType: "agent",
          toolExposureMode: "full",
          accessAllTools: false,
          accessAllSubagents: false,
          accessAllSkills: false,
          scope: "personal",
          isDefault: false,
          isPersonalGateway: false,
          isPersonalProxy: false,
          teams: [],
          tools: [],
          labels: [],
          authorId: "user-1",
          deletedAt: null,
          authorName: "Test User",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          knowledgeBaseIds: [],
          connectorIds: [],
          suggestedPrompts: [],
          llmApiKeyId: null,
          llmModel: null,
          modelId: null,
          considerContextUntrusted: false,
          identityProviderId: null,
          environmentId: null,
          builtInAgentConfig: null,
          passthroughHeaders: null,
          incomingEmailEnabled: false,
          incomingEmailSecurityMode: "public",
          incomingEmailAllowedDomain: null,
          slug: null,
          latestVersion: 0,
        }}
      />,
    );

    const updateButton = screen.getByRole("button", { name: /update/i });
    expect(updateButton).not.toBeDisabled();

    await user.click(updateButton);

    await waitFor(() => {
      expect(pendingSaveChanges).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
    });
  });

  it("does not enable LLM queries when the user lacks LLM read permissions", () => {
    vi.mocked(useHasPermissions).mockImplementation(((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      if ("llmProviderApiKey" in permissions || "llmModel" in permissions) {
        return { data: false };
      }
      return { data: true };
    }) as unknown as typeof useHasPermissions);

    render(
      <AgentDialog open={true} onOpenChange={vi.fn()} agentType="agent" />,
    );

    expect(useAvailableLlmProviderApiKeysMock).toHaveBeenCalledWith({
      includeKeyId: undefined,
      enabled: false,
    });
    expect(useLlmModelsByProviderMock).toHaveBeenCalledWith({
      enabled: false,
    });
  });

  it("shows org default model message when the user cannot read keys or models", () => {
    vi.mocked(useHasPermissions).mockImplementation(((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      if ("llmProviderApiKey" in permissions || "llmModel" in permissions) {
        return { data: false };
      }
      return { data: true };
    }) as unknown as typeof useHasPermissions);

    render(
      <AgentDialog open={true} onOpenChange={vi.fn()} agentType="agent" />,
    );

    expect(
      screen.getByText(
        /you do not have permission to view llm api keys or models/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this agent will use the organization's default model/i),
    ).toBeInTheDocument();
  });
});
