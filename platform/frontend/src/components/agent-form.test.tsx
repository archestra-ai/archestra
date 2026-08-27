import { BUILT_IN_AGENT_IDS, E2eTestId } from "@archestra/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useEnterpriseFeature,
  useFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useConnectors } from "@/lib/knowledge/connector.query";
import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBases,
} from "@/lib/knowledge/knowledge-base.query";
import {
  type AgentFormFooterState,
  type AgentFormProps,
  AgentForm as AgentFormWithoutFooter,
} from "./agent-form";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const {
  pendingSaveChanges,
  ReportedApiError,
  useAvailableLlmProviderApiKeysMock,
  useAgentDelegationsMock,
  useAgentSubagentExclusionsMock,
  useAgentKnowledgeSourceExclusionsMock,
  useUpdateAgentKnowledgeSourceExclusionsMock,
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
  useDefaultAgentIdMock,
  useUpdateDefaultAgentIdMock,
  useAgentToolsMock,
  useBulkUpdateAgentToolsMock,
  useInternalMcpCatalogMock,
} = vi.hoisted(() => ({
  /** Stands in for what the agent write hooks reject with once they toasted. */
  ReportedApiError: class ReportedApiError extends Error {
    name = "ReportedApiError";
  },
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
  useAvailableLlmProviderApiKeysMock: vi.fn(
    (): {
      data: Array<{
        id: string;
        name: string;
        provider: string;
        scope: string;
        bestModelId: string;
      }>;
    } => ({ data: [] }),
  ),
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
  useDefaultAgentIdMock: vi.fn((): { data: string | null } => ({
    data: null,
  })),
  useUpdateDefaultAgentIdMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useAgentToolsMock: vi.fn(
    (): {
      data: Array<{ id: string; catalogId: string | null }>;
      isPending: boolean;
      isError: boolean;
      refetch: ReturnType<typeof vi.fn>;
    } => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
  ),
  useBulkUpdateAgentToolsMock: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useInternalMcpCatalogMock: vi.fn(
    (): {
      data: Array<{
        id: string;
        name: string;
        serverType?: string | null;
        environmentId?: string | null;
      }>;
      isPending: boolean;
      isError: boolean;
    } => ({ data: [], isPending: false, isError: false }),
  ),
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
  useAgentKnowledgeSourceExclusionsMock: vi.fn(
    (): { data: { excludedConnectorIds: string[] }; isSuccess: boolean } => ({
      data: { excludedConnectorIds: [] },
      isSuccess: true,
    }),
  ),
  useUpdateAgentKnowledgeSourceExclusionsMock: vi.fn(() => ({
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
  useDefaultAgentId: useDefaultAgentIdMock,
  useDeleteProfile: useDeleteProfileMock,
  useDelegationTargetAgents: useDelegationTargetAgentsMock,
  useProfile: useProfileMock,
  useUpdateDefaultAgentId: useUpdateDefaultAgentIdMock,
  useUpdateProfile: useUpdateProfileMock,
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: useAgentDelegationsMock,
  useSyncAgentDelegations: useSyncAgentDelegationsMock,
  useAgentTools: useAgentToolsMock,
  useBulkUpdateAgentTools: useBulkUpdateAgentToolsMock,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: useInternalMcpCatalogMock,
}));

vi.mock("sonner");

vi.mock("@/lib/agent-subagent-exclusions.query", () => ({
  useAgentSubagentExclusions: useAgentSubagentExclusionsMock,
  useUpdateAgentSubagentExclusions: useUpdateAgentSubagentExclusionsMock,
}));

vi.mock("@/lib/agent-knowledge-source-exclusions.query", () => ({
  useAgentKnowledgeSourceExclusions: useAgentKnowledgeSourceExclusionsMock,
  useUpdateAgentKnowledgeSourceExclusions:
    useUpdateAgentKnowledgeSourceExclusionsMock,
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
  useConnectors: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: vi.fn(() => ({ data: [] })),
  useIsKnowledgeBaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: useLlmModelsByProviderMock,
  // The "Organization default" label's lookup; the org under test has none.
  useLlmModels: () => ({ data: [] }),
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
  // The real predicate: the query layer marks the errors it already toasted by
  // name, and the form stays quiet for exactly those.
  isReportedApiError: (error: unknown) =>
    error instanceof Error && error.name === "ReportedApiError",
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
  SystemPromptEditor: () => <div>Mock Instruction Editor</div>,
}));

vi.mock("@/components/llm-provider-api-key-dropdown", () => ({
  LlmProviderApiKeyDropdown: ({
    onSelectKey,
  }: {
    onSelectKey: (keyId: string) => void;
  }) => (
    <button type="button" onClick={() => onSelectKey("key-1")}>
      Pick API key
    </button>
  ),
}));

vi.mock("@/components/share-personal-credentials-dialog", () => ({
  SharePersonalCredentialsDialog: () => null,
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="visibility-selector">{children}</div>
  ),
}));

vi.mock("@/components/environment-selector", () => ({
  EnvironmentSelector: ({
    disabled,
    hideWhenOnlyDefault,
    onChange,
  }: {
    disabled?: boolean;
    hideWhenOnlyDefault?: boolean;
    onChange?: (environmentId: string | null) => void;
  }) => (
    <div
      data-testid="environment-selector"
      data-disabled={disabled ? "true" : "false"}
      data-hide-when-only-default={hideWhenOnlyDefault ? "true" : "false"}
    >
      <button type="button" onClick={() => onChange?.("env-2")}>
        Move to other environment
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDescription: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertTitle: ({ children }: { children?: React.ReactNode }) => (
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
    asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  }) =>
    // `asChild` hands the button's place to the caller's element, as the real
    // Slot does, so a link stays a link instead of nesting inside a button.
    asChild ? children : <button {...props}>{children}</button>,
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
  vi.mocked(useConnectors).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useConnectors>);
  vi.mocked(useFeature).mockReturnValue(
    false as unknown as ReturnType<typeof useFeature>,
  );
  vi.mocked(useEnterpriseFeature).mockReturnValue(false);
  vi.mocked(useSmallTeamTier).mockReturnValue(undefined);
  vi.mocked(useAppName).mockReturnValue("Archestra");
});

// The page owns the submit row, so the form renders no button of its own.
// Every render below gets the same Create/Update submit the pages give it, so
// the tests can drive a save the way a user does.
const testFooter = ({ isCreate, canSubmit }: AgentFormFooterState) => (
  <button type="submit" disabled={!canSubmit}>
    <span>{isCreate ? "Create" : "Update"}</span>
  </button>
);
const AgentForm = (props: Omit<AgentFormProps, "footer">) => (
  <AgentFormWithoutFooter {...props} footer={testFooter} />
);

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
  missingCredentialBehavior: "allow" as const,
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

describe("AgentForm delegation state", () => {
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

  it.each([
    "mcp_gateway",
    "profile",
  ] as const)("omits agent-only Subagents for %s forms", (agentType) => {
    render(
      <AgentForm agentType={agentType} agent={{ ...baseAgent, agentType }} />,
    );

    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
    expect(useAgentDelegationsMock).toHaveBeenCalledWith(undefined);
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
      <AgentForm
        agentType="agent"
        agent={{ ...baseAgent, accessAllSubagents: false }}
      />,
    );

    const toggle = await screen.findByTestId(E2eTestId.ConsultAdvisorSwitch);
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText("Answers without consulting the Advisor."),
    ).toBeInTheDocument();
    const openAdvisor = screen.getByRole("link", { name: /open advisor/i });
    expect(openAdvisor).toHaveAttribute("href", `/agents/${advisorAgent.id}`);
    expect(openAdvisor).toHaveAttribute("target", "_blank");

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId(E2eTestId.ConsultAdvisorSwitch)).toBeChecked();
    });
    expect(
      screen.getByText(
        "Gets a second opinion from the Advisor before answering.",
      ),
    ).toBeInTheDocument();
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

    render(<AgentForm agentType="agent" agent={advisorBuiltIn} />);

    // The form's own submit is the last thing it mounts.
    await screen.findByRole("button", { name: /update/i });
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

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    // The switch is the single place the advisor is offered; listing it as a
    // disabled subagent as well would mean two controls for one decision.
    await waitFor(() => {
      expect(
        screen.getByTestId(E2eTestId.ConsultAdvisorSwitch),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(advisorAgent.name)).not.toBeInTheDocument();
    expect(screen.getByText(/All subagents except \(0\)/)).toBeInTheDocument();
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

    render(<AgentForm agentType="agent" agent={autoAgent} />);

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

    render(<AgentForm agentType="agent" agent={autoAgent} />);

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

    render(<AgentForm agentType="agent" agent={autoAgent} />);

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

    render(<AgentForm agentType="agent" agent={customAgent} />);

    const toggle = await screen.findByTestId(E2eTestId.ConsultAdvisorSwitch);
    expect(toggle).not.toBeChecked();

    await user.click(subagentModeTab("Auto"));

    expect(screen.getByText(/All subagents except \(0\)/)).toBeInTheDocument();
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

    render(<AgentForm agentType="agent" agent={customAgent} />);

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

    render(<AgentForm agentType="agent" agent={autoAgent} />);

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
    const onSaved = vi.fn();

    render(<AgentForm onSaved={onSaved} agentType="agent" agent={baseAgent} />);

    await screen.findByText("Subagents (1)");
    await user.click(screen.getByRole("button", { name: /update/i }));

    // The save must complete (reaches the success callback) and persist the
    // agent — proving the handler ran through the sync block, not that it
    // bailed early.
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
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

    render(<AgentForm agentType="agent" agent={baseAgent} />);

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

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

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

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

    expect(await screen.findByText("regraded-skill")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove regraded-skill" }),
    ).toBeInTheDocument();
  });

  it("keeps selected subagents when fresh agent data refetches", async () => {
    const { rerender } = render(
      <AgentForm agentType="agent" agent={baseAgent} />,
    );

    await screen.findByText("Subagents (1)");

    useProfileMock.mockReturnValue({
      data: { ...baseAgent, description: "Refetched description" },
      refetch: vi.fn(),
    });

    rerender(<AgentForm agentType="agent" agent={baseAgent} />);

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

describe("AgentForm personal default", () => {
  const owner = { id: baseAgent.authorId };

  beforeEach(() => {
    vi.clearAllMocks();
    pendingSaveChanges.mockResolvedValue(undefined);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: owner },
    } as unknown as ReturnType<typeof useSession>);
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
  });

  it("offers the switch on a chat agent, on when it is the viewer's default", async () => {
    useDefaultAgentIdMock.mockReturnValue({ data: baseAgent.id });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(
      await screen.findByTestId(E2eTestId.PersonalDefaultAgentSwitch),
    ).toBeChecked();
  });

  it("offers the switch on an agent the viewer does not own", async () => {
    // Pinning a default is about whose chats it starts, not about ownership:
    // any chat agent this viewer can open is one they can pin.
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "someone-else" } },
    } as unknown as ReturnType<typeof useSession>);
    useDefaultAgentIdMock.mockReturnValue({ data: null });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(
      await screen.findByTestId(E2eTestId.PersonalDefaultAgentSwitch),
    ).not.toBeChecked();
  });

  it("saves the member default only when the switch was moved", async () => {
    const user = userEvent.setup();
    const setDefault = vi.fn().mockResolvedValue({ defaultAgentId: null });
    useUpdateDefaultAgentIdMock.mockReturnValue({
      mutateAsync: setDefault,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue(baseAgent),
      isPending: false,
    });
    useDefaultAgentIdMock.mockReturnValue({ data: baseAgent.id });
    const onSaved = vi.fn();

    render(<AgentForm onSaved={onSaved} agentType="agent" agent={baseAgent} />);

    // Untouched → the save leaves the member setting alone.
    await screen.findByTestId(E2eTestId.PersonalDefaultAgentSwitch);
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("clears the member default when the switch is turned off and saved", async () => {
    const user = userEvent.setup();
    const setDefault = vi.fn().mockResolvedValue({ defaultAgentId: null });
    useUpdateDefaultAgentIdMock.mockReturnValue({
      mutateAsync: setDefault,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue(baseAgent),
      isPending: false,
    });
    useDefaultAgentIdMock.mockReturnValue({ data: baseAgent.id });
    const onSaved = vi.fn();

    render(<AgentForm onSaved={onSaved} agentType="agent" agent={baseAgent} />);

    await user.click(
      await screen.findByTestId(E2eTestId.PersonalDefaultAgentSwitch),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(setDefault).toHaveBeenCalledWith(null);
  });
});

describe("AgentForm knowledge in Auto mode", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(true);
  });

  it("says what the knowledge field leaves out rather than what it holds", async () => {
    // Auto mode does not read the assignment, and the set it searches is the
    // caller's — not the editor's — so naming sources here only ever showed
    // the wrong list. The field's own label is what states the rule now.
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(
      within(section).getByText(/All knowledge sources except \(0\)/),
    ).toBeVisible();
    // The preview list and its caption are gone, and so is the prose that
    // used to restate the field above it.
    expect(
      within(section).queryByText(
        /each conversation searches the ones its own caller may query/i,
      ),
    ).toBeNull();
    expect(
      within(section).queryByText(/stay out of this agent's knowledge search/i),
    ).toBeNull();
  });

  it("names a source only where being named means it is excluded", async () => {
    // Auto mode assigns nothing, so it names no source — except in the
    // disabled editor, where a name means the opposite of assignment. That
    // makes it the one list on the step that is safe to read as literal.
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
        {
          id: "c2",
          name: "Legacy wiki",
          connectorType: "confluence",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    useAgentKnowledgeSourceExclusionsMock.mockReturnValue({
      data: { excludedConnectorIds: ["c2"] },
      isSuccess: true,
    });
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    const disabled = within(section).getByTestId(
      E2eTestId.AgentKnowledgeSourceExclusions,
    );
    expect(within(disabled).getByText("Legacy wiki")).toBeVisible();
    // The excluded source is named there and nowhere else, and the source the
    // agent still reaches is not named at all.
    // The Custom-mode editors stay mounted while Auto is on so pending edits
    // survive a mode switch, and jsdom loads no Tailwind, so their `hidden`
    // container is still queryable. Only what Auto shows counts here.
    const shown = (nodes: HTMLElement[]) =>
      nodes.filter((node) => !node.closest(".hidden"));

    expect(
      shown(within(section).getAllByText("Legacy wiki")).every((node) =>
        disabled.contains(node),
      ),
    ).toBe(true);
    expect(shown(within(section).queryAllByText("Handbook"))).toHaveLength(0);
  });

  it("saves the disabled set when a source is turned off", async () => {
    const user = userEvent.setup();
    const syncKnowledgeExclusions = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    useAgentKnowledgeSourceExclusionsMock.mockReturnValue({
      data: { excludedConnectorIds: [] },
      isSuccess: true,
    });
    useUpdateAgentKnowledgeSourceExclusionsMock.mockReturnValue({
      mutateAsync: syncKnowledgeExclusions,
      isPending: false,
    });
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue(autoAgent),
      isPending: false,
    });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const disabled = await screen.findByTestId(
      E2eTestId.AgentKnowledgeSourceExclusions,
    );
    await user.click(
      within(disabled).getByRole("button", { name: "Add Handbook" }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(syncKnowledgeExclusions).toHaveBeenCalled());
    expect(syncKnowledgeExclusions).toHaveBeenCalledWith(
      expect.objectContaining({
        exclusions: { excludedConnectorIds: ["c1"] },
      }),
    );
  });

  it("offers nothing to disable while knowledge search is unconfigured", async () => {
    // The editor lists sources, so it has to follow the same caveat the
    // bullets state: with no embedding model there is no search to narrow.
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(false);
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Handbook",
          connectorType: "notion",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(
      screen.queryByTestId(E2eTestId.AgentKnowledgeSourceExclusions),
    ).toBeNull();
  });

  it("says so when knowledge search has no embedding model behind it", async () => {
    // The warning lives in the field it disables, in both modes, rather than
    // in prose above the form — so it is where the reader is already looking.
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(false);
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(
      within(section).getAllByText(
        /Configure an embedding model to use knowledge sources/i,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("puts tools before knowledge in both modes", async () => {
    // The two modes disagreed on the order — Custom listed tools first, Auto
    // listed knowledge first — so flipping the tab moved the field you were
    // reading. Not incidental markup: the order is the thing being fixed.
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Runbooks",
          connectorType: "github",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    const before = (first: HTMLElement, second: HTMLElement) =>
      Boolean(
        first.compareDocumentPosition(second) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );

    expect(
      before(
        within(section).getByText(/^All tools except/),
        within(section).getByText(/^All knowledge sources except/),
      ),
    ).toBe(true);
    expect(
      before(
        within(section).getByText(/^Tools \(/),
        within(section).getByText(/^Knowledge sources \(/),
      ),
    ).toBe(true);
  });

  it("offers knowledge bases and connectors through one picker in Custom mode", async () => {
    // The two tables used to be two groups behind a Popover of their own,
    // shaped unlike every other field on the step. One list, one pill row: the
    // kind survives as a badge, and both halves still reach their own id list.
    const user = userEvent.setup();
    const updateAgent = vi.fn().mockResolvedValue(baseAgent);
    vi.mocked(useKnowledgeBases).mockReturnValue({
      data: [{ id: "kb1", name: "Company Handbook", connectors: [] }],
    } as unknown as ReturnType<typeof useKnowledgeBases>);
    vi.mocked(useConnectors).mockReturnValue({
      data: [
        {
          id: "c1",
          name: "Runbooks",
          connectorType: "github",
          environmentId: null,
        },
      ],
    } as unknown as ReturnType<typeof useConnectors>);
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    const picker = within(section).getByTestId(E2eTestId.AgentKnowledgeSources);
    // One list, both tables: a knowledge base and a connector are offered side
    // by side, and the Auto field's own list is a separate one.
    await user.click(within(picker).getByText("Add Company Handbook"));
    await user.click(within(picker).getByText("Add Runbooks"));

    expect(
      within(picker).getAllByTestId(E2eTestId.AgentKnowledgeSourcePill).length,
    ).toBe(2);
    expect(within(picker).getByText("Company Handbook")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            knowledgeBaseIds: ["kb1"],
            connectorIds: ["c1"],
          }),
        }),
      ),
    );
  });

  it("keeps quiet about knowledge search once it is configured", async () => {
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(
      within(section).queryByText(
        /Configure an embedding model to use knowledge sources/i,
      ),
    ).toBeNull();
  });
});

describe("AgentForm progressive tool loading", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
  });

  const progressiveSwitch = (section: HTMLElement) =>
    section.querySelector<HTMLInputElement>("#load-tools-when-needed");

  it("shows the setting as on and locked in Auto mode", async () => {
    // Auto mode requires the search/run dispatch surface, and the backend
    // coerces the record to match. The row used to be hidden here, which left
    // the one setting Auto decides for you invisible.
    const autoAgent = {
      ...baseAgent,
      accessAllTools: true,
      toolExposureMode: "search_and_run_only" as const,
    };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(within(section).getByText("Progressive tool loading")).toBeVisible();
    expect(progressiveSwitch(section)?.checked).toBe(true);
    expect(progressiveSwitch(section)?.disabled).toBe(true);
    expect(within(section).getByText(/Auto mode always uses it/)).toBeVisible();
  });

  it("reads as on for an Auto agent whose stored mode says otherwise", async () => {
    // Rows written before the invariant existed can still hold "full". The
    // switch reports what the agent will do, not what the stale column says.
    const staleAutoAgent = {
      ...baseAgent,
      accessAllTools: true,
      toolExposureMode: "full" as const,
    };
    useProfileMock.mockReturnValue({ data: staleAutoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={staleAutoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(progressiveSwitch(section)?.checked).toBe(true);
  });

  it("stays a choice in Custom mode", async () => {
    const user = userEvent.setup();
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    const toggle = progressiveSwitch(section);
    expect(toggle?.checked).toBe(false);
    expect(toggle?.disabled).toBe(false);
    expect(within(section).queryByText(/Auto mode always uses it/)).toBeNull();

    if (toggle) await user.click(toggle);
    expect(progressiveSwitch(section)?.checked).toBe(true);
  });
});

describe("AgentForm published skills", () => {
  const syncSkills = vi.fn();
  const syncSkillExclusions = vi.fn();
  const updateAgent = vi.fn();
  const createAgent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    createAgent.mockResolvedValue({ id: "created-agent", name: "New Agent" });
    useCreateProfileMock.mockReturnValue({
      mutateAsync: createAgent,
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
    const onSaved = vi.fn();

    render(
      <AgentForm onSaved={onSaved} agentType="mcp_gateway" agent={baseAgent} />,
    );

    expect(
      await screen.findByText(/could not load the published skills/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Skills \(/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
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

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

    await screen.findByRole("button", { name: /update/i });
    expect(screen.queryByText(/published skills/i)).not.toBeInTheDocument();
    expect(useAgentSkillsMock).toHaveBeenCalledWith(undefined);
  });

  it("shows no section on a chat agent, and reads nothing for one", async () => {
    // Publishing over `skill://` is a gateway surface: a chat agent has no MCP
    // client to serve resources to, and reaches skills through `load_skill`
    // instead. The section was offered on agents too, which put a control on a
    // screen where nothing consumed what it wrote.
    render(<AgentForm agentType="agent" agent={baseAgent} />);

    await screen.findByRole("button", { name: /update/i });
    expect(screen.queryByText(/published skills/i)).not.toBeInTheDocument();
    expect(useAgentSkillsMock).toHaveBeenCalledWith(undefined);
    expect(useAgentSkillExclusionsMock).toHaveBeenCalledWith(undefined);
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

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

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
    const onSaved = vi.fn();

    render(
      <AgentForm onSaved={onSaved} agentType="mcp_gateway" agent={baseAgent} />,
    );

    await screen.findByText("Skills (1)");
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
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

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

    await screen.findByText(/All skills except \(0\)/);
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

  it("calls the save a success only once the skills write has landed too", async () => {
    // The agent PUT is not the whole save: the skill sets are written after
    // it, and a toast between the two promised a save the API could still
    // refuse — leaving the user reading "updated" over unsaved edits.
    const user = userEvent.setup();
    const onSaved = vi.fn();
    syncSkills.mockRejectedValue(new Error("published skills rejected"));
    useAgentSkillsMock.mockReturnValue({
      data: { accessAllSkills: true, skillIds: [], skills: [] },
      isSuccess: true,
    });

    render(
      <AgentForm onSaved={onSaved} agentType="mcp_gateway" agent={baseAgent} />,
    );

    await screen.findByText(/All skills except \(0\)/);
    await user.click(skillsModeTab("Custom"));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(syncSkills).toHaveBeenCalled());
    expect(updateAgent).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("AgentForm LLM permission gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("does not enable LLM queries when the user lacks LLM read permissions", () => {
    vi.mocked(useHasPermissions).mockImplementation(((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      if ("llmProviderApiKey" in permissions || "llmModel" in permissions) {
        return { data: false };
      }
      return { data: true };
    }) as unknown as typeof useHasPermissions);

    render(<AgentForm agentType="agent" />);

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

    render(<AgentForm agentType="agent" />);

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

describe("AgentForm save payload and failure handling", () => {
  const updateAgent = vi.fn();
  const createAgent = vi.fn();
  const bulkUpdateTools = vi.fn();
  const refetchAgentTools = vi.fn();

  const renderConfiguration = (props?: { onSaved?: () => void }) =>
    render(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
        {...props}
      />,
    );

  const renderTools = () =>
    render(
      <AgentForm agentType="agent" agent={baseAgent} sections={["tools"]} />,
    );

  const savedBody = () =>
    updateAgent.mock.calls[0][0].data as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    pendingSaveChanges.mockResolvedValue(undefined);
    updateAgent.mockResolvedValue(baseAgent);
    createAgent.mockResolvedValue({ id: "created-agent", name: "New Agent" });
    bulkUpdateTools.mockResolvedValue({
      succeeded: [],
      removed: [],
      failed: [],
    });
    useProfileMock.mockReturnValue({ data: null, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [] });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
    useAgentSubagentExclusionsMock.mockReturnValue({
      data: { excludedSubagentIds: [] },
      isSuccess: true,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });
    useCreateProfileMock.mockReturnValue({
      mutateAsync: createAgent,
      isPending: false,
    });
    refetchAgentTools.mockResolvedValue({ data: [], isError: false });
    useAgentToolsMock.mockReturnValue({
      data: [],
      isPending: false,
      isError: false,
      refetch: refetchAgentTools,
    });
    useInternalMcpCatalogMock.mockReturnValue({
      data: [],
      isPending: false,
      isError: false,
    });
    useBulkUpdateAgentToolsMock.mockReturnValue({
      mutateAsync: bulkUpdateTools,
      isPending: false,
    });
    useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
    useLlmModelsByProviderMock.mockReturnValue({ modelsByProvider: {} });
  });

  /**
   * `canSubmit` clears while `isSaving` is true, so a second click cannot start
   * a second save. Observing that needs the save held open: the mocked write
   * hooks hardcode `isPending: false`, so the component's own `isSaving` state
   * is what gates the button, and it only stays true while the awaited
   * mutation is still in flight.
   */
  it("keeps Update disabled while a save is in flight", async () => {
    const user = userEvent.setup();
    let releaseSave: (agent: unknown) => void = () => {};
    updateAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = resolve;
        }),
    );

    renderConfiguration();

    const updateButton = screen.getByRole("button", { name: /update/i });
    expect(updateButton).not.toBeDisabled();

    await user.click(updateButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
    });

    await act(async () => {
      releaseSave(baseAgent);
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /update/i }),
      ).not.toBeDisabled();
    });
  });

  it("sends the configuration step's own fields, and nothing the step does not show", async () => {
    // The PUT is partial, so a step writes back only what it renders. Sending
    // a field the step never showed writes this mount's copy of it — and even
    // when the copy is right, it forks a config version and writes an audit
    // record for an edit nobody made. `agentType` is not editable at all, and
    // the environment and the key/model pair wait until they actually move:
    // re-sending one this caller may no longer assign turns a rename into a
    // permission error.
    const user = userEvent.setup();
    renderConfiguration();

    const name = await screen.findByDisplayValue("Existing Agent");
    await user.clear(name);
    await user.type(name, "Renamed Agent");
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().name).toBe("Renamed Agent");
    expect(Object.keys(savedBody()).sort()).toEqual([
      "description",
      "icon",
      "name",
      "scope",
      "suggestedPrompts",
      "systemPrompt",
      "teams",
      "users",
    ]);
  });

  it("sends the advanced step's own fields, and nothing the step does not show", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AgentForm agentType="agent" agent={baseAgent} sections={["advanced"]} />,
    );

    // The Switch and Label mocks above leave the control unlabelled, so it
    // is reached by the id the label points at.
    await screen.findByText("Security");
    const securitySwitch = container.querySelector<HTMLInputElement>(
      "#consider-context-untrusted",
    );
    if (!securitySwitch) throw new Error("No security switch rendered");
    await user.click(securitySwitch);
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().considerContextUntrusted).toBe(true);
    expect(Object.keys(savedBody()).sort()).toEqual([
      "considerContextUntrusted",
      "identityProviderId",
      "labels",
    ]);
  });

  it("sends the tools step's own fields, and none of the configuration behind it", async () => {
    // The Tools step renders no name, visibility or instruction: those inputs
    // hold whatever this mount was seeded with, so re-sending them would write
    // a stale copy of the configuration back over a concurrent edit.
    const user = userEvent.setup();
    renderTools();

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(Object.keys(savedBody()).sort()).toEqual([
      "accessAllSubagents",
      "accessAllTools",
      "connectorIds",
      "knowledgeBaseIds",
      "missingCredentialBehavior",
      "toolExposureMode",
    ]);
  });

  it("sends the environment once it actually changes", async () => {
    const user = userEvent.setup();
    renderConfiguration();

    await user.click(
      await screen.findByRole("button", { name: /move to other environment/i }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().environmentId).toBe("env-2");
  });

  it("sends the key and the model together when either one changes", async () => {
    // The API validates them against each other, so a model sent without its
    // key (or the reverse) is judged against the stored half of the pair.
    const user = userEvent.setup();
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Org OpenAI",
          provider: "openai",
          scope: "org",
          bestModelId: "model-1",
        },
      ],
    });
    renderConfiguration();

    await user.click(
      await screen.findByRole("button", { name: /pick api key/i }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().llmApiKeyId).toBe("key-1");
    expect(savedBody().modelId).toBe("model-1");
  });

  it("leaves a refused update to the toast the query layer already showed", async () => {
    // The write hooks toast the API's refusal themselves and then reject. The
    // form used to toast it a second time, so one refusal arrived as two
    // identical messages.
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateAgent.mockRejectedValue(
      new ReportedApiError("Environment is restricted"),
    );
    renderConfiguration({ onSaved });

    const name = await screen.findByDisplayValue("Existing Agent");
    await user.type(name, " v2");
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // Still dirty: nothing was written, so the edit is still the user's to save.
    expect(screen.getByDisplayValue("Existing Agent v2")).toBeInTheDocument();
  });

  it("reports a failure that nothing else has reported", async () => {
    // The bulk tool endpoint answers 200 and names what it refused inside the
    // body, so the editor summarises that into an error of its own — this
    // catch is the only place it can reach the user.
    const user = userEvent.setup();
    pendingSaveChanges.mockRejectedValue(
      new Error("Jira: tool could not be assigned"),
    );
    renderTools();

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Jira: tool could not be assigned",
      ),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("blocks the environment change while its tools would be stranded, and clears it by removing them", async () => {
    const user = userEvent.setup();
    useInternalMcpCatalogMock.mockReturnValue({
      data: [
        {
          id: "catalog-1",
          name: "Jira",
          serverType: "remote",
          environmentId: null,
        },
      ],
      isPending: false,
      isError: false,
    });
    useAgentToolsMock.mockReturnValue({
      data: [
        { id: "tool-1", catalogId: "catalog-1" },
        { id: "tool-2", catalogId: "catalog-1" },
      ],
      isPending: false,
      isError: false,
      refetch: refetchAgentTools,
    });
    renderConfiguration();

    await user.click(
      await screen.findByRole("button", { name: /move to other environment/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /update/i })).toBeDisabled(),
    );
    expect(screen.getByText(/1 MCP server/)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /remove 2 incompatible tools/i }),
    );

    // The removal is persisted first; only then is the environment saved.
    await waitFor(() =>
      expect(bulkUpdateTools).toHaveBeenCalledWith({
        removals: [
          { agentId: baseAgent.id, toolId: "tool-1" },
          { agentId: baseAgent.id, toolId: "tool-2" },
        ],
      }),
    );
    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().environmentId).toBe("env-2");
  });

  it("leaves the environment unsaved when the removal fails", async () => {
    const user = userEvent.setup();
    bulkUpdateTools.mockRejectedValue(new Error("nope"));
    useInternalMcpCatalogMock.mockReturnValue({
      data: [
        {
          id: "catalog-1",
          name: "Jira",
          serverType: "remote",
          environmentId: null,
        },
      ],
      isPending: false,
      isError: false,
    });
    useAgentToolsMock.mockReturnValue({
      data: [{ id: "tool-1", catalogId: "catalog-1" }],
      isPending: false,
      isError: false,
      refetch: refetchAgentTools,
    });
    renderConfiguration();

    await user.click(
      await screen.findByRole("button", { name: /move to other environment/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /remove 1 incompatible tool/i }),
    );

    await waitFor(() => expect(bulkUpdateTools).toHaveBeenCalled());
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("leaves the environment unsaved when the removal is refused inside a 200", async () => {
    // The bulk endpoint reports a refusal in `failed` rather than by failing,
    // so a resolved removal is not on its own a cleared conflict — and saving
    // the environment on it strands the tools it was supposed to free.
    const user = userEvent.setup();
    bulkUpdateTools.mockResolvedValue({
      succeeded: [],
      removed: [],
      failed: [{ error: "Tool is pinned by a policy" }],
    });
    useInternalMcpCatalogMock.mockReturnValue({
      data: [
        {
          id: "catalog-1",
          name: "Jira",
          serverType: "remote",
          environmentId: null,
        },
      ],
      isPending: false,
      isError: false,
    });
    useAgentToolsMock.mockReturnValue({
      data: [{ id: "tool-1", catalogId: "catalog-1" }],
      isPending: false,
      isError: false,
      refetch: refetchAgentTools,
    });
    renderConfiguration();

    await user.click(
      await screen.findByRole("button", { name: /move to other environment/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /remove 1 incompatible tool/i }),
    );

    await waitFor(() => expect(bulkUpdateTools).toHaveBeenCalled());
    expect(updateAgent).not.toHaveBeenCalled();
    expect(refetchAgentTools).not.toHaveBeenCalled();
  });

  it("keeps every step's editors mounted while one step shows, and submits only when told to", async () => {
    // The create wizard walks one form across its steps: what a hidden step
    // holds (the tools picked on it) must survive the step change, and Enter
    // on an earlier step must not create the record.
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentForm
        agentType="agent"
        activeSection="configuration"
        submitEnabled={false}
      />,
    );

    const toolsEditor = await screen.findByText("Mock Tools Editor");
    expect(toolsEditor.closest(".divide-y")).toHaveClass("hidden");
    expect(
      screen.getByPlaceholderText("Enter agent name").closest(".divide-y"),
    ).not.toHaveClass("hidden");

    await user.type(
      screen.getByPlaceholderText("Enter agent name"),
      "New Agent{Enter}",
    );
    expect(createAgent).not.toHaveBeenCalled();

    rerender(
      <AgentForm
        agentType="agent"
        activeSection="tools"
        submitEnabled={false}
      />,
    );
    expect(
      screen.getByText("Mock Tools Editor").closest(".divide-y"),
    ).not.toHaveClass("hidden");
    // Same mount: the name typed on the first step is still there.
    expect(screen.getByPlaceholderText("Enter agent name")).toHaveValue(
      "New Agent",
    );

    rerender(
      <AgentForm agentType="agent" activeSection="advanced" submitEnabled />,
    );
    expect(screen.getByText("Advanced").closest(".divide-y")).not.toHaveClass(
      "hidden",
    );
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    const body = createAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "New Agent",
      labels: [],
      suggestedPrompts: [],
      considerContextUntrusted: false,
      identityProviderId: null,
      accessAllTools: true,
    });
    // Omitted, not null: the backend resolves the org's landing environment.
    expect(body).not.toHaveProperty("environmentId");
    // What the hidden Tools step held is written against the new id.
    expect(pendingSaveChanges).toHaveBeenCalledWith({
      agentId: "created-agent",
      resourceLabel: "agent",
    });
  });

  it("deletes the record it just created when a follow-up write is refused", async () => {
    const user = userEvent.setup();
    const deleteCreated = vi.fn().mockResolvedValue({ id: "created-agent" });
    useDeleteProfileMock.mockReturnValue({
      mutateAsync: deleteCreated,
      isPending: false,
    });
    pendingSaveChanges.mockRejectedValue(new Error("Tools were refused"));
    const onCreated = vi.fn();
    render(<AgentForm agentType="agent" onCreated={onCreated} />);

    await user.type(
      await screen.findByPlaceholderText("Enter agent name"),
      "New Agent",
    );
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(deleteCreated).toHaveBeenCalledWith("created-agent"),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Tools were refused");
  });
});

describe("AgentForm read-only footer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingSaveChanges.mockResolvedValue(undefined);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: baseAgent.authorId } },
    } as unknown as ReturnType<typeof useSession>);
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
  });

  it("gives a read-only form an exit instead of no footer at all", async () => {
    // Reached by URL on a record the viewer may not change: every field is
    // disabled and there is nothing to save, so without this the only way off
    // the page was the browser's back button.
    render(<AgentForm agentType="agent" agent={baseAgent} readOnly />);

    const cancel = await screen.findByRole("link", { name: "Cancel" });
    expect(cancel).toHaveAttribute("href", `/agents/${baseAgent.id}`);
    // Nothing that implies a save: the caller's submit row is not rendered.
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  });

  it("keeps the caller's own footer when the form is editable", async () => {
    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(
      await screen.findByRole("button", { name: /update/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();
  });
});
