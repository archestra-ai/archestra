import {
  type archestraApiTypes,
  BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS,
  BUILT_IN_AGENT_IDS,
  E2eTestId,
  getAgentCatalogImages,
  type SupportedProvider,
} from "@archestra/shared";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  useKnowledgeBasesByIds,
} from "@/lib/knowledge/knowledge-base.query";
import {
  type AgentFormFooterState,
  type AgentFormProps,
  AgentForm as AgentFormWithoutFooter,
} from "./agent-form";
import { getAgentCatalogTemplates } from "./agent-pages/agent-catalog";
import { defaultAgentRuntime } from "./agent-runtime-fields";

const TEST_CATALOG_IMAGES = getAgentCatalogImages({
  registry: "example.com",
  tag: "latest",
});

HTMLElement.prototype.scrollIntoView = vi.fn();

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

// Legacy behavior fixtures remain local; real HTTP paging is covered by the
// remote-selector integration suite.
vi.mock("@/lib/agent-options.query", () => ({
  useAgentOptionsByIds: () => useDelegationTargetAgentsMock(),
  useAgentOptionIds: () => ({
    data: (
      useDelegationTargetAgentsMock()
        .data as archestraApiTypes.GetAgentOptionsResponses["200"]["data"]
    ).map((row: { id: string }) => row.id),
    isSuccess: true,
  }),
  useAgentOptionsPage: (params: { search?: string }) => {
    const result = useDelegationTargetAgentsMock() as {
      data: archestraApiTypes.GetAgentOptionsResponses["200"]["data"];
    };
    const search = params.search?.trim().toLowerCase() ?? "";
    const rows = (result.data ?? []).filter(
      (row: {
        name?: string;
        description?: string | null;
        authorEmail?: string | null;
      }) =>
        !search ||
        [row.name, row.description, row.authorEmail].some((value) =>
          value?.toLowerCase().includes(search),
        ),
    );
    return {
      data: {
        pages: [
          { data: rows, pagination: { hasNext: false, nextCursor: null } },
        ],
      },
      isSuccess: true,
      isLoading: false,
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/lib/agent-runtime-templates.query", () => ({
  useRuntimeTemplateCatalog: () => ({
    data: [],
    isFetching: false,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useResolveRuntimeTemplate: () => ({ isPending: false, mutate: vi.fn() }),
  useBuiltInRuntimeDefaults: () => () => undefined,
  // The runtime has no account rule unless a test gives it one: it names no
  // kind of account, and fixes no connection or model.
  useAgentRuntimePermissions: () => ({
    accounts: null,
    ...runtimePermissions.current,
  }),
  useAgentRuntimeAccess: () => ({
    data: {
      runtimes: [
        "claude-code",
        "codex",
        "opencode",
        "hermes",
        "openclaw",
        "grok",
        "kimi",
        "copilot",
      ].map((id) => ({ id, canUse: true, canConfigure: true })),
      canConfigureAny: true,
    },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
const runtimePermissions = vi.hoisted(() => ({
  current: { canChange: true, canConfigure: true, readOnlyBy: null } as {
    canChange: boolean | undefined;
    canConfigure: boolean | undefined;
    readOnlyBy: string | null;
    accounts?: {
      kind?: "subscription" | "key";
      llmApiKeyId?: string;
      modelId?: string;
      keyName?: string;
      keyProvider?: string;
      modelName?: string;
      keyMissing?: true;
      modelMissing?: true;
      connectionModels?: Record<string, string>;
      connectionModelNames?: Record<string, string>;
      models?: Array<{
        id: string;
        modelId: string;
        displayName: string;
        provider: string;
      }>;
    } | null;
  },
}));
// Everyone may use and configure the runtime unless a test says otherwise.
beforeEach(() => {
  runtimePermissions.current = {
    canChange: true,
    canConfigure: true,
    readOnlyBy: null,
  };
});
vi.mock("next/navigation");

const {
  pendingSaveChanges,
  ReportedApiError,
  useAvailableLlmProviderApiKeysMock,
  useAgentDelegationsMock,
  useAgentSubagentExclusionsMock,
  useAgentKnowledgeSourceExclusionsMock,
  useUpdateAgentKnowledgeSourceExclusionsMock,
  useAgentActivationSkillsMock,
  useAgentActivationSkillPolicyMock,
  usePatchAgentActivationSkillPolicyMock,
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
  useAgentRuntimePreflightMock,
  useOrganizationDefaultModelMock,
  useA2aRemoteAgentsMock,
  useAgentA2aDelegationsMock,
  useSyncAgentA2aDelegationsMock,
  saveChannelChangesMock,
} = vi.hoisted(() => ({
  /** Stands in for what the agent write hooks reject with once they toasted. */
  ReportedApiError: class ReportedApiError extends Error {
    name = "ReportedApiError";
  },
  pendingSaveChanges: vi.fn(
    () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ),
  saveChannelChangesMock: vi.fn(async () => true),
  useDelegationTargetAgentsMock: vi.fn(
    (): { data: unknown[]; isFetching?: boolean } => ({
      data: [],
    }),
  ),
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
        subscriptionKind?: string | null;
        isPrimary?: boolean;
        isGithubAppKey?: boolean;
        githubOrganizationName?: string | null;
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
  useAgentRuntimePreflightMock: vi.fn(() => ({ data: undefined })),
  useOrganizationDefaultModelMock: vi.fn(
    (): {
      model: null;
      label: string | null;
      autoRoutedTiers: null;
      autoRouters: Array<{
        id: string;
        name: string;
        label: string;
        description: string;
        tiers: Record<
          "fast" | "normal" | "smart",
          { id: string; provider: "anthropic"; displayName: string }
        >;
      }>;
      defaultAutoRouterId: string | null;
    } => ({
      model: null,
      label: null,
      autoRoutedTiers: null,
      autoRouters: [],
      defaultAutoRouterId: null,
    }),
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
  useA2aRemoteAgentsMock: vi.fn(
    (): { data: unknown[]; isPending: boolean } => ({
      data: [],
      isPending: false,
    }),
  ),
  useAgentA2aDelegationsMock: vi.fn(
    (): {
      data: unknown[];
      isPending: boolean;
      isSuccess: boolean;
      isError: boolean;
    } => ({
      data: [],
      isPending: false,
      isSuccess: true,
      isError: false,
    }),
  ),
  useSyncAgentA2aDelegationsMock: vi.fn(() => ({
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
  useAgentActivationSkillsMock: vi.fn(
    (): {
      data: {
        enabled: boolean;
        data: unknown[];
        pagination: {
          currentPage: number;
          limit: number;
          total: number;
          totalPages: number;
          hasNext: boolean;
          hasPrev: boolean;
        };
      };
      isPending: boolean;
      isFetching: boolean;
      isError: boolean;
      isSuccess: boolean;
    } => ({
      data: {
        enabled: true,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    }),
  ),
  useAgentActivationSkillPolicyMock: vi.fn(() => ({
    data: {
      mode: "all",
      revision: 0,
      allowedReferences: [],
      excludedReferences: [],
      hiddenAllowedCount: 0,
      hiddenExcludedCount: 0,
      allowedSkills: [],
      excludedSkills: [],
    },
    isSuccess: true,
    isError: false,
  })),
  usePatchAgentActivationSkillPolicyMock: vi.fn(() => ({
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

vi.mock("@/components/initial-resource-permissions", () => ({
  InitialResourcePermissions: () => null,
}));

// The per-agent network policy editor reads the cluster's policy support.
vi.mock("@/lib/environment.query", async () => ({
  ...(await vi.importActual("@/lib/environment.query")),
  useK8sCapabilities: () => ({
    data: {
      networkPolicy: {
        supportsFqdn: true,
        enforcementStatus: "verified-enforced",
      },
    },
  }),
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

vi.mock("@/lib/claude-code-account.query", () => ({
  useClaudeCodeAccount: () => ({ data: undefined, isPending: false }),
  useClaudeCodeModels: () => ({ data: [] }),
  useClaudeCodeSignIn: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectClaudeCodeAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/agent-runtime.query", () => ({
  useAgentRuntimePreflight: useAgentRuntimePreflightMock,
}));

vi.mock("@/lib/hooks/use-organization-default-model", () => ({
  useOrganizationDefaultModel: useOrganizationDefaultModelMock,
}));

vi.mock("@/lib/a2a-remote-agents.query", () => ({
  useA2aRemoteAgents: useA2aRemoteAgentsMock,
  useAgentA2aDelegations: useAgentA2aDelegationsMock,
  useSyncAgentA2aDelegations: useSyncAgentA2aDelegationsMock,
}));

// The environment-conflict check reads the agent's catalogs by id.
vi.mock("@/lib/mcp/use-mcp-registry-rows-by-ids", () => ({
  // Answers from the catalog rows each test sets, for the ids asked.
  useMcpRegistryRowsByIds: (ids: string[]) => {
    const catalog = useInternalMcpCatalogMock() ?? {};
    return {
      data: ((catalog.data ?? []) as Array<{ id: string }>).filter((row) =>
        ids.includes(row.id),
      ),
      isPending: catalog.isPending ?? false,
      hasLoaded: !(catalog.isPending ?? false),
      isError: catalog.isError ?? false,
      refetch: async () => [],
    };
  },
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
  useInternalMcpCatalog: useInternalMcpCatalogMock,
}));

vi.mock("sonner");

vi.mock("@/lib/agent-identity-bindings.query", () => ({
  useAgentIdentityBindings: () => ({ data: [], isSuccess: true }),
  useReplaceAgentIdentityBindings: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

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
  useAgentActivationSkills: useAgentActivationSkillsMock,
  useAgentActivationSkillPolicy: useAgentActivationSkillPolicyMock,
  usePatchAgentActivationSkillPolicy: usePatchAgentActivationSkillPolicyMock,
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
  useConnectorsByIds: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: vi.fn(() => ({ data: [] })),
  useKnowledgeBasesByIds: vi.fn(() => ({ data: [] })),
  useIsKnowledgeBaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: useLlmModelsByProviderMock,
  // The "Organization default" label's lookup; the org under test has none.
  useLlmModels: () => ({ data: [] }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  // The list has answered unless a test says otherwise.
  useAvailableLlmProviderApiKeys: (
    ...args: Parameters<typeof useAvailableLlmProviderApiKeysMock>
  ) => ({ isFetched: true, ...useAvailableLlmProviderApiKeysMock(...args) }),
}));

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/docs/docs", () => ({
  getFrontendDocsUrl: () => "/docs",
}));

vi.mock("@/lib/utils/tailwind", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/api")>()),
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

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => null,
}));

vi.mock("@/components/chat/model-selector", () => ({
  ModelSelector: ({
    selectedModel,
    onModelChange,
    modelFilter,
  }: {
    selectedModel: string;
    onModelChange?: (modelId: string) => void;
    modelFilter?: (model: {
      id: string;
      provider: SupportedProvider;
    }) => boolean;
  }) => (
    <>
      <output data-testid="selected-model">{selectedModel}</output>
      {onModelChange && (
        <button type="button" onClick={() => onModelChange("manual-model")}>
          Pick manual model
        </button>
      )}
      {modelFilter && (
        <>
          <output data-testid="runtime-model-filter">
            {JSON.stringify({
              gemini: modelFilter({ id: "gemini-2.5-pro", provider: "gemini" }),
              openai: modelFilter({ id: "gpt-4o", provider: "openai" }),
              anthropic: modelFilter({
                id: "claude-sonnet-4-6",
                provider: "anthropic",
              }),
              bedrock: modelFilter({
                id: "us.anthropic.claude-sonnet-4-6",
                provider: "bedrock",
              }),
            })}
          </output>
          <output data-testid="runtime-bedrock-model-filter">
            {JSON.stringify({
              claude: modelFilter({
                id: "anthropic.claude-sonnet-4-6",
                provider: "bedrock",
              }),
              nova: modelFilter({
                id: "amazon.nova-pro-v1:0",
                provider: "bedrock",
              }),
            })}
          </output>
        </>
      )}
    </>
  ),
}));

vi.mock("@/components/external-docs-link", () => ({
  ExternalDocsLink: () => null,
}));

vi.mock("@/components/permission-requirement-hint", () => ({
  PermissionRequirementHint: () => null,
  formatPermissionRequirement: () => "",
}));

vi.mock("@/components/system-prompt-editor", () => ({
  SystemPromptEditor: ({
    value,
    onChange,
    headerExtra,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    headerExtra?: React.ReactNode;
  }) => (
    <div>
      Mock Instruction Editor
      {headerExtra}
      <textarea
        aria-label="Instructions"
        value={value ?? ""}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  ),
}));

vi.mock("@/components/agent-chat-apps", () => ({
  AgentChatAppsEditor: ({
    onDirtyChange,
    onSaveHandlerChange,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
    onSaveHandlerChange?: (handler: (() => Promise<boolean>) | null) => void;
  }) => {
    onSaveHandlerChange?.(saveChannelChangesMock);
    return (
      <div>
        Mock Chat Apps Editor
        <button type="button" onClick={() => onDirtyChange?.(true)}>
          Mark channel changes dirty
        </button>
      </div>
    );
  },
}));

vi.mock("./agent-runtime-fields", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agent-runtime-fields")>();
  return {
    ...actual,
    AgentRuntimeFields: ({
      value,
      onChange,
    }: {
      value: { inferenceProtocol: string } | null;
      onChange: (value: object | null) => void;
    }) => (
      <div data-testid="agent-runtime">
        <button
          type="button"
          onClick={() => onChange(actual.defaultAgentRuntime())}
        >
          Enable runtime
        </button>
        <button
          type="button"
          onClick={() =>
            value &&
            onChange({
              ...value,
              image: "example.com/custom:v1",
              command: ["my-agent"],
            })
          }
        >
          Set runtime image and command
        </button>
        <button
          type="button"
          onClick={() =>
            value &&
            onChange({ ...value, inferenceProtocol: "openai_responses" })
          }
        >
          Set runtime to OpenAI Responses
        </button>
        <button type="button" onClick={() => onChange(null)}>
          Disable runtime
        </button>
      </div>
    ),
  };
});

vi.mock(
  "@/app/settings/messaging-channels/email/agent-email-settings-dialog",
  () => ({
    AgentEmailSettingsDialog: () => null,
  }),
);

vi.mock("@/components/llm-provider-api-key-dropdown", () => ({
  LlmProviderApiKeyDropdown: ({
    onAddApiKey,
    onSelectKey,
    onSelectOrganizationDefault,
    providerFilter,
    autoRouters = [],
  }: {
    onAddApiKey?: () => void;
    onSelectKey: (keyId: string) => void;
    onSelectOrganizationDefault?: () => void;
    providerFilter?: (provider: SupportedProvider) => boolean;
    autoRouters?: Array<{
      id: string;
      label: string;
      selected: boolean;
      onSelect: () => void;
    }>;
  }) => (
    <>
      <button type="button" onClick={() => onSelectKey("key-1")}>
        Pick API key
      </button>
      {autoRouters.map((router) => (
        <button
          key={router.id}
          type="button"
          aria-pressed={router.selected}
          onClick={router.onSelect}
        >
          {`Pick ${router.label}`}
        </button>
      ))}
      {autoRouters.length > 0 && onSelectOrganizationDefault && (
        <button type="button" onClick={onSelectOrganizationDefault}>
          Pick organization default
        </button>
      )}
      {onAddApiKey && (
        <button type="button" onClick={onAddApiKey}>
          Add provider key
        </button>
      )}
      {providerFilter && (
        <output data-testid="runtime-provider-filter">
          {JSON.stringify({
            gemini: providerFilter("gemini"),
            openai: providerFilter("openai"),
            anthropic: providerFilter("anthropic"),
            bedrock: providerFilter("bedrock"),
          })}
        </output>
      )}
    </>
  ),
}));

// A runtime agent picks its company connection and model in the composer's
// menu; the same stub buttons and outputs as the dropdown and model selector
// above keep the form-level tests about key and model selection working for
// both. Like the real fields, they are disabled as a whole, and a connection
// decided elsewhere (`connectionFixed`) leaves only the model to pick.
vi.mock("@/components/claude-connection-pickers", () => ({
  CompanyConnectionPickers: ({
    onAddApiKey,
    onApiKeyChange,
    runsOn,
    connectionFixed = false,
    apiKeyId,
    modelId,
    onModelChange,
    modelFilter,
    disabled = false,
    lockedConnection,
    modelLocked = false,
    modelName,
    models,
    onApiKeyClear,
    onModelClear,
  }: {
    onAddApiKey?: () => void;
    onApiKeyChange: (keyId: string) => void;
    runsOn: (provider: SupportedProvider) => boolean;
    connectionFixed?: boolean;
    apiKeyId: string | null;
    modelId: string | null;
    lockedConnection?: { name: string } | null;
    modelLocked?: boolean;
    modelName?: string | null;
    models?: Array<{ dbId: string; displayName: string }>;
    onApiKeyClear?: () => void;
    onModelClear?: () => void;
    onModelChange: (modelId: string) => void;
    modelFilter?: (model: {
      id: string;
      provider: SupportedProvider;
    }) => boolean;
    disabled?: boolean;
  }) => (
    <>
      {!connectionFixed && (
        <button
          type="button"
          disabled={disabled || !!lockedConnection}
          onClick={() => onApiKeyChange("key-1")}
        >
          Pick API key
        </button>
      )}
      {lockedConnection && (
        <output data-testid="locked-connection">{lockedConnection.name}</output>
      )}
      <output data-testid="selected-model-name">{modelName ?? ""}</output>
      {onAddApiKey && (
        <button type="button" disabled={disabled} onClick={onAddApiKey}>
          Add provider key
        </button>
      )}
      <output data-testid="runtime-provider-filter">
        {JSON.stringify({
          gemini: runsOn("gemini"),
          openai: runsOn("openai"),
          anthropic: runsOn("anthropic"),
          bedrock: runsOn("bedrock"),
          xai: runsOn("xai"),
        })}
      </output>
      <output data-testid="selected-model">{modelId ?? ""}</output>
      {apiKeyId && (
        <button
          type="button"
          disabled={disabled || modelLocked}
          // From the caller's own list where it gives one.
          onClick={() => onModelChange(models?.[0]?.dbId ?? "manual-model")}
        >
          Pick manual model
        </button>
      )}
      {onApiKeyClear && apiKeyId && !connectionFixed && !lockedConnection && (
        <button type="button" disabled={disabled} onClick={onApiKeyClear}>
          Clear connection
        </button>
      )}
      {onModelClear && apiKeyId && modelId && !modelLocked && (
        <button type="button" disabled={disabled} onClick={onModelClear}>
          Clear model
        </button>
      )}
      {models && (
        <output data-testid="offered-models">
          {models.map((model) => model.displayName).join(", ")}
        </output>
      )}
      {apiKeyId && modelFilter && (
        <>
          <output data-testid="runtime-model-filter">
            {JSON.stringify({
              gemini: modelFilter({ id: "gemini-2.5-pro", provider: "gemini" }),
              openai: modelFilter({ id: "gpt-4o", provider: "openai" }),
              anthropic: modelFilter({
                id: "claude-sonnet-4-6",
                provider: "anthropic",
              }),
              bedrock: modelFilter({
                id: "us.anthropic.claude-sonnet-4-6",
                provider: "bedrock",
              }),
            })}
          </output>
          <output data-testid="runtime-bedrock-model-filter">
            {JSON.stringify({
              claude: modelFilter({
                id: "anthropic.claude-sonnet-4-6",
                provider: "bedrock",
              }),
              nova: modelFilter({
                id: "amazon.nova-pro-v1:0",
                provider: "bedrock",
              }),
            })}
          </output>
        </>
      )}
    </>
  ),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: ({
    allowedProviders,
    credentialMode,
    description,
    onSuccess,
    open,
    showConsoleLink,
    title,
  }: {
    allowedProviders?: SupportedProvider[];
    credentialMode?: string;
    description: string;
    onSuccess?: (keyId?: string) => void;
    open: boolean;
    showConsoleLink?: boolean;
    title: string;
  }) =>
    open ? (
      <div>
        <span>{title}</span>
        <span>{description}</span>
        <output data-testid="create-key-allowed-providers">
          {allowedProviders?.join(",")}
        </output>
        <output data-testid="create-key-mode">
          {`${credentialMode}:${showConsoleLink}`}
        </output>
        <button type="button" onClick={() => onSuccess?.("created-key-id")}>
          Create provider key
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/share-personal-credentials-dialog", () => ({
  SharePersonalCredentialsDialog: () => null,
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
    label,
  }: {
    items: Array<{ id: string; name: string }>;
    onToggle: (id: string) => void;
    onSearchChange?: (query: string) => void;
    placeholder?: string;
    isSearching?: boolean;
    label?: string;
  }) => (
    <div>
      <button type="button">{label ?? "Add"}</button>
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
  Badge: (props: React.ComponentProps<"span">) => <span {...props} />,
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
  CommandItem: ({
    children,
    onSelect,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="option" onClick={onSelect}>
      {children}
    </button>
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
  DialogBody: ({ children }: { children?: React.ReactNode }) => (
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
  PopoverAnchor: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/select", async () => {
  // Options are reachable only after the trigger opens the list, and the
  // trigger shows the chosen item's label, so a broken trigger or value fails.
  const { createContext, useContext, useLayoutEffect, useState } = await import(
    "react"
  );
  const SelectContext = createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    labels: Record<string, string>;
    setLabel: (value: string, label: string) => void;
  }>({
    open: false,
    setOpen: () => undefined,
    labels: {},
    setLabel: () => undefined,
  });
  const textOf = (node: React.ReactNode): string =>
    typeof node === "string" || typeof node === "number"
      ? String(node)
      : Array.isArray(node)
        ? node.map(textOf).join("")
        : "";
  return {
    Select: function Select({
      children,
      value,
      onValueChange,
    }: {
      children?: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) {
      const [open, setOpen] = useState(false);
      const [labels, setLabels] = useState<Record<string, string>>({});
      return (
        <SelectContext.Provider
          value={{
            value,
            onValueChange,
            open,
            setOpen,
            labels,
            setLabel: (item, label) =>
              setLabels((current) =>
                current[item] === label
                  ? current
                  : { ...current, [item]: label },
              ),
          }}
        >
          <div>{children}</div>
        </SelectContext.Provider>
      );
    },
    SelectContent: function SelectContent({
      children,
    }: {
      children?: React.ReactNode;
    }) {
      const select = useContext(SelectContext);
      return (
        <div role="listbox" hidden={!select.open}>
          {children}
        </div>
      );
    },
    SelectItem: function SelectItem({
      children,
      value,
    }: {
      children?: React.ReactNode;
      value: string;
    }) {
      const select = useContext(SelectContext);
      const label = textOf(children);
      const { setLabel } = select;
      useLayoutEffect(() => setLabel(value, label), [setLabel, value, label]);
      return (
        <div
          role="option"
          aria-selected={select.value === value}
          tabIndex={-1}
          onClick={() => {
            select.onValueChange?.(value);
            select.setOpen(false);
          }}
          onKeyDown={() => undefined}
        >
          {children}
        </div>
      );
    },
    SelectTrigger: function SelectTrigger({
      children,
      id,
      "aria-label": ariaLabel,
    }: {
      children?: React.ReactNode;
      id?: string;
      "aria-label"?: string;
    }) {
      const select = useContext(SelectContext);
      return (
        <button
          type="button"
          role="combobox"
          aria-controls={undefined}
          aria-expanded={select.open}
          id={id}
          aria-label={ariaLabel}
          onClick={() => select.setOpen(!select.open)}
        >
          {children}
        </button>
      );
    },
    SelectValue: function SelectValue({
      placeholder,
    }: {
      placeholder?: string;
    }) {
      const select = useContext(SelectContext);
      return (
        <span>
          {(select.value !== undefined && select.labels[select.value]) ||
            placeholder ||
            ""}
        </span>
      );
    },
  };
});

vi.mock("@/components/ui/switch", () => ({
  // A real checkbox rather than null: a switch's checked state is
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
  saveChannelChangesMock.mockResolvedValue(true);
  useA2aRemoteAgentsMock.mockReturnValue({ data: [], isPending: false });
  useAgentA2aDelegationsMock.mockReturnValue({
    data: [],
    isPending: false,
    isSuccess: true,
    isError: false,
  });
  useSyncAgentA2aDelegationsMock.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
  vi.mocked(usePathname).mockReturnValue("/agents/agent-1");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
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
  runtime: null,
  runtimeSecretId: null,
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
  activationSkillMode: "all" as const,
  activationSkillPolicyRevision: 0,
  scope: "personal" as const,
  isDefault: false,
  isPersonalGateway: false,
  isPersonalProxy: false,
  teams: [],
  tools: [],
  labels: [],
  authorId: "00000000-0000-4000-8000-000000000020",
  createdByServiceAccountId: null,
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
  modelPoolId: null,
  autoRouterId: null,
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

/**
 * The step panel a control belongs to. Each panel is one run of settings
 * sections, and the one that is not the active step is hidden rather than
 * unmounted.
 */
const panelOf = (node: HTMLElement) =>
  node.closest("section")?.parentElement ?? null;

// The Tools section carries its own All/Manual cards, so the subagent ones are
// reached through their own group.
const subagentAccess = () =>
  screen.getByRole("radiogroup", { name: "Subagent access" });
const subagentMode = (name: "All agents" | "Manual") =>
  within(subagentAccess()).getByRole("radio", {
    name: new RegExp(`^${name}`),
  });

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

  // A gateway advertises its subagents as delegation tools on every
  // `tools/list` it answers, so it configures them here like an agent does.
  it.each([
    "mcp_gateway",
    "profile",
  ] as const)("offers Agents, not Subagents, on %s forms, seeded from that record's sets", (agentType) => {
    render(
      <AgentForm agentType={agentType} agent={{ ...baseAgent, agentType }} />,
    );

    // A gateway's agents are called by its clients, not by another agent.
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Subagents" }),
    ).not.toBeInTheDocument();
    expect(useAgentDelegationsMock).toHaveBeenCalledWith(baseAgent.id);
  });

  it("marks only the experimental subagent options as Beta", () => {
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent],
    });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const subagentsHeading = screen.getByRole("heading", {
      name: "Subagents",
    });
    expect(within(subagentsHeading).queryByText("Beta")).toBeNull();

    const externalAgentsTitle = screen.getByText("External Agents");
    expect(
      within(externalAgentsTitle.parentElement as HTMLElement).getByText(
        "Beta",
      ),
    ).toBeInTheDocument();
  });

  it("saves a gateway's subagent mode and delegation set", async () => {
    const user = userEvent.setup();
    const gateway = {
      ...baseAgent,
      agentType: "mcp_gateway" as const,
      accessAllSubagents: false,
    };
    const updateAgent = vi.fn().mockResolvedValue(gateway);
    const syncDelegations = vi
      .fn()
      .mockResolvedValue({ added: [targetAgent.id], removed: [] });
    useProfileMock.mockReturnValue({ data: gateway, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    useAgentDelegationsMock.mockReturnValue({ data: [], isSuccess: true });
    useSyncAgentDelegationsMock.mockReturnValue({
      mutateAsync: syncDelegations,
      isPending: false,
    });
    useUpdateProfileMock.mockReturnValue({
      mutateAsync: updateAgent,
      isPending: false,
    });

    render(<AgentForm agentType="mcp_gateway" agent={gateway} />);

    const section = screen
      .getByRole("heading", { name: "Agents" })
      .closest("section") as HTMLElement;
    expect(within(section).getByText("No agents assigned")).toBeInTheDocument();
    expect(
      within(section).getByText(
        "No delegation tools appear in this gateway's tool list.",
      ),
    ).toBeInTheDocument();
    await user.click(
      within(section).getByRole("combobox", { name: "Add agent" }),
    );
    await user.click(screen.getByRole("option", { name: /Target Agent/ }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ accessAllSubagents: false }),
        }),
      ),
    );
    expect(syncDelegations).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgentIds: [targetAgent.id] }),
    );
  });

  it("assigns an outbound A2A agent explicitly even while local subagents use All mode", async () => {
    const user = userEvent.setup();
    const syncExternal = vi.fn();
    const autoAgent = { ...baseAgent, accessAllSubagents: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });
    useA2aRemoteAgentsMock.mockReturnValue({
      data: [
        {
          id: "remote-agent-1",
          name: "External Compliance Agent",
          description: "Checks policy requirements",
          connection: { id: "connection-1", enabled: true },
        },
      ],
      isPending: false,
    });
    useSyncAgentA2aDelegationsMock.mockReturnValue({
      mutateAsync: syncExternal,
      isPending: false,
    });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    expect(useA2aRemoteAgentsMock).toHaveBeenCalledWith({ enabled: true });

    const picker = screen.getByRole("button", {
      name: "Add outbound agent",
    });
    expect(picker).toBeInTheDocument();
    expect(screen.getByText("External Agents")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /External Compliance Agent/,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: /External Compliance Agent.*A2A/,
      }),
    ).toBeInTheDocument();
    expect(syncExternal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() =>
      expect(syncExternal).toHaveBeenCalledWith({
        agentId: baseAgent.id,
        connectionIds: ["connection-1"],
      }),
    );
  });

  it("does not offer external A2A assignment before a new agent has been saved", () => {
    useA2aRemoteAgentsMock.mockReturnValue({
      data: [
        {
          id: "remote-agent-1",
          name: "External Compliance Agent",
          description: null,
          connection: { id: "connection-1", enabled: true },
        },
      ],
      isPending: false,
    });

    render(<AgentForm agentType="agent" />);

    expect(
      screen.getByText(
        "You can add external agents after you create this agent.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Exclude a local agent" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add outbound agent" }),
    ).not.toBeInTheDocument();
    expect(useAgentA2aDelegationsMock).toHaveBeenCalledWith(undefined);
  });

  it.each([
    "create",
    "edit",
  ])("uses canonical subagent details in the %s flow", async (flow) => {
    const user = userEvent.setup();
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [
        {
          ...targetAgent,
          icon: "🔭",
          scope: "personal",
          authorName: "Agent Owner",
        },
      ],
    });

    render(
      <AgentForm
        agentType="agent"
        agent={flow === "edit" ? baseAgent : undefined}
      />,
    );

    await user.click(subagentMode("Manual"));
    await user.click(screen.getByRole("combobox", { name: "Add subagent" }));

    const option = screen.getByRole("option", { name: /Target Agent/ });
    expect(within(option).getByText("🔭")).toBeInTheDocument();
    expect(within(option).getByText("Agent Owner")).toBeInTheDocument();
  });

  it("adds a subagent in Manual mode and only excludes one in All mode", async () => {
    const user = userEvent.setup();
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    render(<AgentForm agentType="agent" />);

    // All mode already includes every local agent, so nothing offers to add.
    expect(
      screen.queryByRole("combobox", { name: "Add subagent" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "Exclude a local agent" }),
    );
    await user.click(screen.getByRole("option", { name: /Target Agent/ }));
    await user.keyboard("{Escape}");
    expect(subagentMode("All agents")).toBeChecked();
    expect(
      within(subagentAccess()).getByText("1 excluded"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Include agent ${targetAgent.name} again`,
      }),
    ).toBeInTheDocument();

    await user.click(subagentMode("Manual"));
    await user.click(screen.getByRole("combobox", { name: "Add subagent" }));
    await user.click(screen.getByRole("option", { name: /Target Agent/ }));
    await user.keyboard("{Escape}");
    expect(
      within(subagentAccess()).getByText("1 assigned"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Remove agent ${targetAgent.name}` }),
    ).toBeInTheDocument();
  });

  it("keeps assigned subagents on screen while a new pick loads", async () => {
    const user = userEvent.setup();
    const newAgent = {
      ...baseAgent,
      id: "00000000-0000-4000-8000-000000000003",
      name: "New Agent",
    };
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, newAgent],
    });
    render(<AgentForm agentType="agent" agent={baseAgent} />);
    await user.click(subagentMode("Manual"));
    expect(
      screen.getByRole("button", { name: `Remove agent ${targetAgent.name}` }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Add subagent" }));
    const option = screen.getByRole("option", { name: /New Agent/ });
    // The lookup for the grown id list is in flight and only has the rows it
    // resolved before.
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent],
      isFetching: true,
    });
    await user.click(option);
    await user.keyboard("{Escape}");

    expect(
      within(subagentAccess()).getByText("2 assigned"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Remove agent ${targetAgent.name}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading subagent" }),
    ).toBeInTheDocument();

    // Once the lookup answers, the pending pill becomes the new agent's.
    useDelegationTargetAgentsMock.mockReturnValue({
      data: [targetAgent, newAgent],
      isFetching: false,
    });
    await user.click(subagentMode("All agents"));
    await user.click(subagentMode("Manual"));
    expect(
      screen.queryByRole("status", { name: "Loading subagent" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Remove agent ${newAgent.name}` }),
    ).toBeInTheDocument();
  });

  it.each([
    "create",
    "edit",
  ])("offers creation of a missing subagent only in Manual mode in the %s flow", async (flow) => {
    const user = userEvent.setup();
    useDelegationTargetAgentsMock.mockReturnValue({ data: [] });
    render(
      <AgentForm
        agentType="agent"
        agent={flow === "edit" ? baseAgent : undefined}
      />,
    );

    await user.click(subagentMode("Manual"));
    await user.click(screen.getByRole("combobox", { name: "Add subagent" }));
    expect(
      screen.getByRole("link", { name: "Create a New Agent" }),
    ).toHaveAttribute("href", "/agents/new");
    await user.click(subagentMode("All agents"));
    expect(
      screen.queryByRole("link", { name: "Create a New Agent" }),
    ).not.toBeInTheDocument();
  });

  it("shows local and outbound A2A assignments in their separate sections", async () => {
    const customAgent = { ...baseAgent, accessAllSubagents: false };
    useProfileMock.mockReturnValue({ data: customAgent, refetch: vi.fn() });
    useDelegationTargetAgentsMock.mockReturnValue({ data: [targetAgent] });
    useAgentDelegationsMock.mockReturnValue({
      data: [targetAgent],
      isSuccess: true,
    });
    useA2aRemoteAgentsMock.mockReturnValue({
      data: [
        {
          id: "remote-agent-1",
          name: "External Research Agent",
          description: "Researches remote systems",
          connection: { id: "connection-1", enabled: true },
        },
      ],
      isPending: false,
    });
    useAgentA2aDelegationsMock.mockReturnValue({
      data: [
        {
          remoteAgentId: "remote-agent-1",
          connectionId: "connection-1",
          toolId: "tool-1",
          name: "External Research Agent",
          description: "Researches remote systems",
          enabled: true,
        },
      ],
      isPending: false,
      isSuccess: true,
      isError: false,
    });

    render(<AgentForm agentType="agent" agent={customAgent} />);

    expect(
      await screen.findByRole("button", { name: /Target AgentLocal/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("External Agents")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /External Research Agent.*A2A/,
      }),
    ).toBeInTheDocument();
    // The outbound agent is not counted among the local subagents.
    expect(subagentMode("Manual")).toBeChecked();
    expect(
      within(subagentAccess()).getByText("1 assigned"),
    ).toBeInTheDocument();
  });

  it("does not replace external assignments after their read fails", async () => {
    const user = userEvent.setup();
    const syncExternal = vi.fn();
    useAgentA2aDelegationsMock.mockReturnValue({
      data: [],
      isPending: false,
      isSuccess: false,
      isError: true,
    });
    useSyncAgentA2aDelegationsMock.mockReturnValue({
      mutateAsync: syncExternal,
      isPending: false,
    });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Outbound A2A agents could not be loaded.",
    );
    expect(
      screen.queryByRole("button", { name: /add outbound agent/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(syncExternal).not.toHaveBeenCalled());
  });

  it("omits Subagents on an LLM proxy, which has no MCP surface to advertise one on", () => {
    render(
      <AgentForm
        agentType="llm_proxy"
        agent={{ ...baseAgent, agentType: "llm_proxy" }}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
    expect(useAgentDelegationsMock).toHaveBeenCalledWith(undefined);
  });

  it("hides messaging-channel configuration without organization settings access", () => {
    vi.mocked(useHasPermissions).mockImplementation(((
      permissions: unknown,
    ) => ({
      data: !(permissions && "organizationSettings" in (permissions as object)),
    })) as typeof useHasPermissions);

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(screen.queryByText("Mock Chat Apps Editor")).toBeNull();
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

    await within(subagentAccess()).findByText("1 assigned");
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

    await within(subagentAccess()).findByText("1 assigned");
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

    expect(
      await screen.findByRole("button", { name: "off-page-skill" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Remove off-page-skill/ }),
    ).toBeInTheDocument();
  });

  it("renders a chip for an excluded skill that has since left org scope", async () => {
    // Nothing prunes an exclusion when the skill it names is re-scoped, so the
    // id outlives the scope it was made under. Filtering the picker to org
    // scope alone stranded it: the count said one, no chip appeared, and the id
    // was re-submitted verbatim on every save with no way to drop it.
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

    expect(
      await screen.findByRole("button", { name: "regraded-skill" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Remove regraded-skill/ }),
    ).toBeInTheDocument();
  });

  it("keeps selected subagents when fresh agent data refetches", async () => {
    const { rerender } = render(
      <AgentForm agentType="agent" agent={baseAgent} />,
    );

    await within(subagentAccess()).findByText("1 assigned");

    useProfileMock.mockReturnValue({
      data: { ...baseAgent, description: "Refetched description" },
      refetch: vi.fn(),
    });

    rerender(<AgentForm agentType="agent" agent={baseAgent} />);

    await waitFor(() => {
      expect(
        within(subagentAccess()).getByText("1 assigned"),
      ).toBeInTheDocument();
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

// The Tools and Subagents sections carry their own All/Manual cards, so the
// published-skill ones have to be reached through their section.
const publishedSkillsSection = () =>
  screen
    .getByRole("heading", { name: "Skills over MCP" })
    .closest("section") as HTMLElement;
const publishedSkillsMode = (name: "All skills" | "Manual") =>
  within(publishedSkillsSection()).getByRole("radio", {
    name: new RegExp(`^${name}`),
  });

describe("AgentForm knowledge in Auto mode", () => {
  beforeEach(() => {
    useAgentActivationSkillPolicyMock.mockReturnValue({
      data: {
        mode: "all",
        revision: 0,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
      isSuccess: true,
      isError: false,
    });
    usePatchAgentActivationSkillPolicyMock.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    useAgentActivationSkillsMock.mockReturnValue({
      data: {
        enabled: true,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useIsKnowledgeBaseConfigured).mockReturnValue(true);
  });

  it("shows the All/Manual skill policy in the tools step", async () => {
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = (
      await screen.findByRole("heading", { name: "Skills" })
    ).closest("section") as HTMLElement;
    expect(
      within(section).getByRole("radio", { name: /^All skills/ }),
    ).toBeVisible();
    expect(
      within(section).getByRole("radio", { name: /^Manual/ }),
    ).toBeVisible();
    expect(useAgentActivationSkillsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: baseAgent.id,
        environmentId: undefined,
        view: "eligible",
      }),
    );
  });

  it("saves an edited internal-agent skill policy with the agent form", async () => {
    const skill = {
      reference: { source: "native" as const, skillId: "skill-1" },
      name: "incident-response",
      activationName: "incident-response",
      description: "Respond to incidents",
      scope: "org" as const,
      providerName: null,
    };
    const patchPolicy = vi.fn().mockResolvedValue(undefined);
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });
    useAgentActivationSkillPolicyMock.mockReturnValue({
      data: {
        mode: "all",
        revision: 4,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
      isSuccess: true,
      isError: false,
    });
    useAgentActivationSkillsMock.mockReturnValue({
      data: {
        enabled: true,
        data: [skill],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    });
    usePatchAgentActivationSkillPolicyMock.mockReturnValue({
      mutateAsync: patchPolicy,
      isPending: false,
    });
    const user = userEvent.setup();

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = (
      await screen.findByRole("heading", { name: "Skills" })
    ).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("radio", { name: /^Manual/ }));
    await user.click(
      within(section).getByRole("button", { name: "Add incident-response" }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() =>
      expect(patchPolicy).toHaveBeenCalledWith({
        agentId: baseAgent.id,
        patch: {
          expectedRevision: 4,
          mode: "manual",
          operations: [
            {
              op: "add",
              disposition: "allow",
              reference: skill.reference,
            },
          ],
        },
      }),
    );
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
      within(section).getByText(/Every knowledge source, with no exceptions\./),
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
      within(section).getAllByText(/Knowledge isn.t set up/i).length,
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

    // Auto mode: the exclusion pickers, in the same order. Both mode panels
    // stay mounted, so both can be checked from one render.
    expect(
      before(
        within(section).getByTestId(E2eTestId.AgentToolExclusions),
        within(section).getByTestId(E2eTestId.AgentKnowledgeSourceExclusions),
      ),
    ).toBe(true);
    // Custom mode: the tool picker precedes the knowledge picker. The mode
    // summaries now sit in the block header above both panels, so the editors
    // are what carry the order.
    expect(
      before(
        within(section).getByTestId(E2eTestId.AgentToolAssignments),
        within(section).getByTestId(E2eTestId.AgentKnowledgeSources),
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

  it("shows a saved knowledge base the picker's first page does not hold", async () => {
    // The picker lists a first page of every knowledge base; a source saved on
    // the record from past that page is read by id so its pill still renders
    // and can be removed.
    const savedAgent = {
      ...baseAgent,
      accessAllTools: false,
      knowledgeBaseIds: ["kb-far"],
    };
    vi.mocked(useKnowledgeBases).mockReturnValue({
      data: [{ id: "kb1", name: "Company Handbook", connectors: [] }],
    } as unknown as ReturnType<typeof useKnowledgeBases>);
    vi.mocked(useKnowledgeBasesByIds).mockImplementation(
      (ids) =>
        ({
          data: ids.includes("kb-far")
            ? [{ id: "kb-far", name: "Far Handbook", connectors: [] }]
            : [],
        }) as unknown as ReturnType<typeof useKnowledgeBasesByIds>,
    );
    useProfileMock.mockReturnValue({ data: savedAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={savedAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    const picker = within(section).getByTestId(E2eTestId.AgentKnowledgeSources);
    expect(
      within(picker).getAllByTestId(E2eTestId.AgentKnowledgeSourcePill),
    ).toHaveLength(1);
    expect(within(picker).getByText("Far Handbook")).toBeVisible();
    vi.mocked(useKnowledgeBasesByIds).mockReset();
    vi.mocked(useKnowledgeBasesByIds).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useKnowledgeBasesByIds>);
  });

  it("keeps quiet about knowledge search once it is configured", async () => {
    const autoAgent = { ...baseAgent, accessAllTools: true };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    const section = await screen.findByTestId(E2eTestId.AgentToolsSection);
    expect(within(section).queryByText(/Knowledge isn.t set up/i)).toBeNull();
  });
});

describe("AgentForm progressive tool loading", () => {
  beforeEach(() => {
    useProfileMock.mockReturnValue({ data: null, refetch: vi.fn() });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
  });

  const progressiveSwitch = (section: HTMLElement) =>
    section.querySelector<HTMLInputElement>("#load-tools-when-needed");

  it.each([
    "agent",
    "mcp_gateway",
  ] as const)("defaults new Manual %s to progressive loading and allows an opt-out", async (agentType) => {
    const user = userEvent.setup();
    render(<AgentForm agentType={agentType} />);
    const tools = await screen.findByTestId(E2eTestId.AgentToolsSection);
    await user.click(within(tools).getByRole("radio", { name: /^Manual/ }));
    const section = await screen.findByTestId(
      E2eTestId.AgentToolLoadingSection,
    );
    const toggle = progressiveSwitch(section);
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(false);
    if (toggle) await user.click(toggle);
    expect(progressiveSwitch(section)?.checked).toBe(false);
  });

  it("hides both settings in All mode, where the record decides neither", async () => {
    // All pins progressive loading on and the connection prompt to asking when
    // a tool needs one, so there is nothing to decide: the mode's own summary
    // line says what happens instead of two locked controls saying it twice.
    const autoAgent = {
      ...baseAgent,
      accessAllTools: true,
      toolExposureMode: "search_and_run_only" as const,
    };
    useProfileMock.mockReturnValue({ data: autoAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={autoAgent} />);

    // `hidden` rather than unmounted: both panels stay mounted so a mode flip
    // keeps pending edits, so the class is what the assertion has to read.
    const section = await screen.findByTestId(
      E2eTestId.AgentToolLoadingSection,
    );
    expect(section).toHaveClass("hidden");
    expect(
      screen.getByText(/To save context, the agent sees only/),
    ).toBeVisible();
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

    const section = await screen.findByTestId(
      E2eTestId.AgentToolLoadingSection,
    );
    expect(progressiveSwitch(section)?.checked).toBe(true);
  });

  it("stays a choice in Custom mode", async () => {
    const user = userEvent.setup();
    useProfileMock.mockReturnValue({ data: baseAgent, refetch: vi.fn() });

    render(<AgentForm agentType="agent" agent={baseAgent} />);

    const section = await screen.findByTestId(
      E2eTestId.AgentToolLoadingSection,
    );
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
      screen.getByRole("button", { name: /^Remove far-away-skill/ }),
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
      screen.getByRole("button", { name: /^Remove far-away-skill/ }),
    ).toBeInTheDocument();
  });

  it("previews the same All-mode skills offered by the exclusion picker", async () => {
    const user = userEvent.setup();
    const first = orgSkill(
      "first-skill",
      "00000000-0000-4000-8000-0000000000ac",
    );
    const second = orgSkill(
      "second-skill",
      "00000000-0000-4000-8000-0000000000ad",
    );
    useAgentSkillsMock.mockReturnValue({
      data: { accessAllSkills: true, skillIds: [], skills: [] },
      isSuccess: true,
    });
    useSkillsPaginatedMock.mockReturnValue({
      data: { data: [first, second] },
      isFetching: false,
    });

    render(<AgentForm agentType="mcp_gateway" agent={baseAgent} />);

    const section = screen
      .getByRole("heading", { name: "Skills over MCP" })
      .closest("section") as HTMLElement;
    expect(
      within(section).getByRole("button", { name: "View all 2 skills" }),
    ).toBeVisible();

    await user.click(
      within(section).getByRole("button", { name: "Disable Skill" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add first-skill" }),
    );
    await user.click(
      within(section).getByRole("button", { name: "View 1 Skill" }),
    );

    const list = screen.getByRole("list", { name: "Skills" });
    expect(within(list).queryByText("first-skill")).toBeNull();
    expect(within(list).getByText("second-skill")).toBeVisible();
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

    await within(publishedSkillsSection()).findByText("1 assigned");
    expect(publishedSkillsMode("Manual")).toBeChecked();
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

    await within(publishedSkillsSection()).findByText("None excluded");
    expect(publishedSkillsMode("All skills")).toBeChecked();
    await user.click(publishedSkillsMode("Manual"));
    expect(screen.getByText("Skills over MCP")).toBeInTheDocument();

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

    await within(publishedSkillsSection()).findByText("None excluded");
    expect(publishedSkillsMode("All skills")).toBeChecked();
    await user.click(publishedSkillsMode("Manual"));
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
    useAgentActivationSkillPolicyMock.mockReturnValue({
      data: {
        mode: "all",
        revision: 0,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
      isSuccess: true,
      isError: false,
    });
    usePatchAgentActivationSkillPolicyMock.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    useAgentActivationSkillsMock.mockReturnValue({
      data: {
        enabled: true,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    });
    vi.mocked(useHasPermissions).mockImplementation(
      () => ({ data: true }) as unknown as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
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

  // The environment and the suggested prompts live on the Advanced step, so
  // the tests that drive them mount that one.
  const renderAdvanced = () =>
    render(
      <AgentForm agentType="agent" agent={baseAgent} sections={["advanced"]} />,
    );

  // Messaging channels are a section of their own, so a surface that saves
  // both — the create wizard, and anything mounting every group — has to
  // mount both.
  const renderConfigurationWithChannels = () =>
    render(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration", "messaging"]}
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
    useAgentActivationSkillPolicyMock.mockReturnValue({
      data: {
        mode: "all",
        revision: 0,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
      isSuccess: true,
      isError: false,
    });
    usePatchAgentActivationSkillPolicyMock.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    useAgentActivationSkillsMock.mockReturnValue({
      data: {
        enabled: true,
        data: [],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    });
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
    useAgentRuntimePreflightMock.mockReturnValue({ data: undefined });
    useOrganizationDefaultModelMock.mockReturnValue({
      model: null,
      label: null,
      autoRoutedTiers: null,
      autoRouters: [],
      defaultAutoRouterId: null,
    });
  });

  describe("auto routers", () => {
    const routerTiers = (prefix: string) => ({
      fast: {
        id: `${prefix}-fast`,
        provider: "anthropic" as const,
        displayName: `${prefix} Haiku`,
      },
      normal: {
        id: `${prefix}-normal`,
        provider: "anthropic" as const,
        displayName: `${prefix} Sonnet`,
      },
      smart: {
        id: `${prefix}-smart`,
        provider: "anthropic" as const,
        displayName: `${prefix} Opus`,
      },
    });
    const routerA = {
      id: "router-a",
      name: "auto",
      label: "Auto",
      description: "A Haiku, A Sonnet, A Opus",
      tiers: routerTiers("A"),
    };
    const routerB = {
      id: "router-b",
      name: "auto:support",
      label: "Auto · support",
      description: "B Haiku, B Sonnet, B Opus",
      tiers: routerTiers("B"),
    };
    const offerRouters = (routers: (typeof routerA)[]) =>
      useOrganizationDefaultModelMock.mockReturnValue({
        model: null,
        label: null,
        autoRoutedTiers: null,
        autoRouters: routers,
        defaultAutoRouterId: null,
      });
    const renderOnRouter = (autoRouterId: string | null) =>
      render(
        <AgentForm
          agentType="agent"
          agent={{ ...baseAgent, autoRouterId }}
          sections={["configuration"]}
        />,
      );

    it("offers one option per router and saves the picked router's id", async () => {
      offerRouters([routerA, routerB]);
      const user = userEvent.setup();
      renderOnRouter(null);

      expect(
        await screen.findByRole("button", { name: "Pick Auto" }),
      ).toHaveAttribute("aria-pressed", "false");
      await user.click(
        screen.getByRole("button", { name: "Pick Auto · support" }),
      );
      expect(
        screen.getByRole("button", { name: "Pick Auto · support" }),
      ).toHaveAttribute("aria-pressed", "true");
      // The model control names that router, not the first one.
      expect(
        screen.getByRole("button", { name: /Auto · support.*3 models/ }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalled());
      expect(savedBody()).toMatchObject({
        autoRouterId: "router-b",
        llmApiKeyId: null,
        modelId: null,
        modelPoolId: null,
      });
    });

    it("moves an agent from one router to another", async () => {
      offerRouters([routerA, routerB]);
      const user = userEvent.setup();
      renderOnRouter("router-b");

      expect(
        await screen.findByRole("button", { name: "Pick Auto · support" }),
      ).toHaveAttribute("aria-pressed", "true");
      await user.click(screen.getByRole("button", { name: "Pick Auto" }));
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalled());
      expect(savedBody()).toMatchObject({ autoRouterId: "router-a" });
    });

    it("clears the router when the agent goes back to the organization default", async () => {
      offerRouters([routerA, routerB]);
      const user = userEvent.setup();
      renderOnRouter("router-a");

      await user.click(
        await screen.findByRole("button", {
          name: "Pick organization default",
        }),
      );
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalled());
      expect(savedBody()).toMatchObject({ autoRouterId: null });
    });

    it("clears the router when a provider key is picked", async () => {
      offerRouters([routerA]);
      const user = userEvent.setup();
      renderOnRouter("router-a");

      await user.click(
        await screen.findByRole("button", { name: "Pick API key" }),
      );
      expect(screen.getByRole("button", { name: "Pick Auto" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("keeps a saved router selected, as Auto, once it is no longer offered", async () => {
      offerRouters([routerA]);
      renderOnRouter("router-gone");

      const options = await screen.findAllByRole("button", {
        name: "Pick Auto",
      });
      expect(
        options.map((option) => option.getAttribute("aria-pressed")),
      ).toEqual(["false", "true"]);
    });
  });

  it.each([
    "agent",
    "mcp_gateway",
  ] as const)("submits the progressive default or an explicit Manual opt-out for a new %s", async (agentType) => {
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType={agentType}
        initialValues={{ accessAllTools: false }}
      />,
    );
    await user.type(screen.getByLabelText("Name *"), "Manual Resource");
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      agentType,
      accessAllTools: false,
      toolExposureMode: "search_and_run_only",
    });
    const toggle = screen
      .getByTestId(E2eTestId.AgentToolLoadingSection)
      .querySelector<HTMLInputElement>("#load-tools-when-needed");
    expect(toggle).not.toBeNull();
    if (toggle) await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(2));
    expect(createAgent.mock.calls[1][0]).toMatchObject({
      accessAllTools: false,
      toolExposureMode: "full",
    });
  });

  /**
   * `canSubmit` clears while `isSaving` is true, so a second click cannot start
   * a second save. Observing that needs the save held open: the mocked write
   * hooks hardcode `isPending: false`, so the component's own `isSaving` state
   * is what gates the button, and it only stays true while the awaited
   * mutation is still in flight.
   */

  describe("a built-in agent", () => {
    const builtInName = BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION;
    const defaultPrompt = BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS[builtInName];
    const builtInAgent = {
      ...baseAgent,
      builtIn: true,
      builtInAgentConfig: { name: builtInName },
      systemPrompt: "Customized title prompt",
    };

    const renderBuiltIn = () =>
      render(
        <AgentForm
          agentType="agent"
          agent={builtInAgent}
          sections={["configuration"]}
        />,
      );

    beforeEach(() => {
      useProfileMock.mockReturnValue({ data: builtInAgent, refetch: vi.fn() });
      updateAgent.mockResolvedValue(builtInAgent);
    });

    it("saves an edited prompt", async () => {
      const user = userEvent.setup();
      renderBuiltIn();

      const editor = await screen.findByLabelText("Instructions");
      await user.clear(editor);
      await user.type(editor, "Write short titles");
      await user.click(screen.getByRole("button", { name: /update/i }));

      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody()).toMatchObject({
        builtInAgentConfig: { name: builtInName },
        systemPrompt: "Write short titles",
      });
    });

    it("saves the shipped prompt after Reset to default", async () => {
      const user = userEvent.setup();
      renderBuiltIn();

      await user.click(
        await screen.findByRole("button", { name: /reset to default/i }),
      );
      expect(screen.getByLabelText("Instructions")).toHaveValue(defaultPrompt);
      expect(
        screen.getByRole("button", { name: /reset to default/i }),
      ).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().systemPrompt).toBe(defaultPrompt.trim());
    });

    it("offers no labels", async () => {
      renderBuiltIn();

      await screen.findByLabelText("Instructions");
      expect(screen.queryByText("Labels", { exact: true })).toBeNull();
    });

    it("saves its assigned tools, without the All mode", async () => {
      const user = userEvent.setup();
      pendingSaveChanges.mockResolvedValue(undefined);
      render(
        <AgentForm
          agentType="agent"
          agent={builtInAgent}
          sections={["configuration", "tools"]}
        />,
      );

      expect(screen.getByText("Mock Tools Editor")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
      expect(screen.queryByText("Tools & Knowledge")).toBeNull();
      expect(
        screen.queryByRole("radiogroup", { name: "Tool access" }),
      ).toBeNull();

      await user.click(screen.getByRole("button", { name: /update/i }));

      await waitFor(() => expect(pendingSaveChanges).toHaveBeenCalledTimes(1));
      expect(savedBody()).not.toHaveProperty("accessAllTools");
    });
  });
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

  it("keeps saved runtime settings read-only without use of the runtime", () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    runtimePermissions.current = {
      canChange: false,
      canConfigure: false,
      readOnlyBy: null,
    };
    render(
      <AgentForm agentType="agent" agent={baseAgent} activeSection="runtime" />,
    );
    expect(
      screen.getByRole("button", { name: "Enable runtime" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/You don't have permission to use this agent's runtime/),
    ).toBeInTheDocument();
  });

  it("omits the saved runtime when an ordinary editor changes an agent name", async () => {
    const user = userEvent.setup();
    runtimePermissions.current = {
      canChange: false,
      canConfigure: false,
      readOnlyBy: null,
    };
    const runtime = {
      ...defaultAgentRuntime(),
      image: "example.test/worker:v1",
    };
    render(<AgentForm agentType="agent" agent={{ ...baseAgent, runtime }} />);
    await user.type(
      await screen.findByDisplayValue("Existing Agent"),
      " renamed",
    );
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(updateAgent.mock.calls[0][0].data).not.toHaveProperty("runtime");
  });

  it("hides existing runtime settings when another form panel is active", () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const { rerender } = render(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        activeSection="configuration"
      />,
    );
    const runtimePanel = () =>
      screen.getByTestId("agent-runtime").closest("fieldset")?.parentElement;
    expect(runtimePanel()).toHaveClass("hidden");
    rerender(
      <AgentForm agentType="agent" agent={baseAgent} activeSection="runtime" />,
    );
    expect(runtimePanel()).not.toHaveClass("hidden");
  });

  it("opens the shared provider-key dialog from the agent picker", async () => {
    const user = userEvent.setup();
    renderConfiguration();

    await user.click(screen.getByRole("button", { name: "Add provider key" }));

    expect(screen.getByText("Add API Key")).toBeInTheDocument();
    expect(
      screen.getByText("Add an LLM provider API key."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("create-key-mode")).toHaveTextContent(
      "api-key:true",
    );
  });

  it("selects a newly created key after its available-key refetch", async () => {
    const user = userEvent.setup();
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "created-model",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    const view = renderConfiguration();
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    await user.click(
      screen.getByRole("button", { name: "Create provider key" }),
    );

    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "created-key-id",
          name: "Created OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "created-model",
        },
      ],
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
      />,
    );

    expect(await screen.findByTestId("selected-model")).toHaveTextContent(
      "created-model",
    );
  });

  it("does not let a delayed created key overwrite a manual picker choice", async () => {
    const user = userEvent.setup();
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Manual OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "manual-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "manual-model",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
          {
            dbId: "created-model",
            id: "gpt-4.1",
            displayName: "GPT-4.1",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    const view = renderConfiguration();
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    await user.click(
      screen.getByRole("button", { name: "Create provider key" }),
    );
    await user.click(screen.getByRole("button", { name: "Pick API key" }));

    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Manual OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "manual-model",
        },
        {
          id: "created-key-id",
          name: "Created OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "created-model",
        },
      ],
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
      />,
    );

    expect(await screen.findByTestId("selected-model")).toHaveTextContent(
      "manual-model",
    );
  });

  it("does not let a delayed created key overwrite a manual model choice", async () => {
    const user = userEvent.setup();
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Existing Gemini key",
          provider: "gemini",
          scope: "personal",
          bestModelId: "initial-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "initial-model",
            id: "gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            provider: "gemini",
            isFree: false,
          },
          {
            dbId: "manual-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
        openai: [
          {
            dbId: "created-model",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    const view = renderConfiguration();
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    await user.click(
      screen.getByRole("button", { name: "Create provider key" }),
    );
    await user.click(screen.getByRole("button", { name: "Pick manual model" }));
    expect(await screen.findByTestId("selected-model")).toHaveTextContent(
      "manual-model",
    );

    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Existing Gemini key",
          provider: "gemini",
          scope: "personal",
          bestModelId: "initial-model",
        },
        {
          id: "created-key-id",
          name: "Created OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "created-model",
        },
      ],
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
      />,
    );

    expect(await screen.findByTestId("selected-model")).toHaveTextContent(
      "manual-model",
    );
  });

  it("does not select a created provider incompatible with the agent runtime", async () => {
    const user = userEvent.setup();
    const runtime = {
      image: "example.com/coding-agent:latest",
      command: ["archestra-codex"],
      inferenceProtocol: "openai_responses" as const,
      backend: "kubernetes" as const,
      steerMode: "pipe" as const,
      privileged: false,
      environment: null,
      credentials: null,
      ttlHours: null,
      maxCostUsd: null,
      idleTimeoutMinutes: null,
    };
    const view = render(
      <AgentForm
        agentType="agent"
        agent={{ ...baseAgent, runtime }}
        sections={["configuration"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    expect(
      screen.getByTestId("create-key-allowed-providers"),
    ).toHaveTextContent("openai");
    await user.click(
      screen.getByRole("button", { name: "Create provider key" }),
    );

    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "created-key-id",
          name: "Created Gemini key",
          provider: "gemini",
          scope: "personal",
          bestModelId: "gemini-model",
        },
      ],
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        agent={{ ...baseAgent, runtime }}
        sections={["configuration"]}
      />,
    );

    expect(await screen.findByTestId("selected-model")).toBeEmptyDOMElement();
  });

  it("saves messaging channel changes before the agent update", async () => {
    const user = userEvent.setup();
    renderConfigurationWithChannels();

    await user.click(
      screen.getByRole("button", { name: "Mark channel changes dirty" }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(saveChannelChangesMock).toHaveBeenCalledTimes(1);
    expect(saveChannelChangesMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateAgent.mock.invocationCallOrder[0],
    );
  });

  it("stops the agent update when messaging channel changes fail", async () => {
    const user = userEvent.setup();
    saveChannelChangesMock.mockResolvedValueOnce(false);
    renderConfigurationWithChannels();

    await user.click(
      screen.getByRole("button", { name: "Mark channel changes dirty" }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(saveChannelChangesMock).toHaveBeenCalled());
    expect(updateAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
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
      // The instructions are part of this panel now, so one save covers them.
      "systemPrompt",
    ]);
  });

  it("blocks saving an existing model that is incompatible with its dedicated runtime", async () => {
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });

    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "gemini-key",
          modelId: "gemini-model",
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    expect(
      await screen.findByText("Choose a compatible model or runtime to save."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("enables Save after correcting a stale preflight incompatibility", async () => {
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "agentRuntime") as unknown as typeof useFeature,
    );
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });
    useAgentRuntimePreflightMock.mockReturnValue({
      data: {
        ready: false,
        incompatible: "This Agent Runtime image expects the Anthropic API.",
        missing: [],
        misconfigured: [],
      },
    } as never);
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "gemini-key",
          modelId: "gemini-model",
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["runtime"]}
        activeSection="runtime"
      />,
    );

    await screen.findByText("Choose a compatible model or runtime to save.");
    await user.click(
      screen.getByRole("button", {
        name: "Set runtime to OpenAI Responses",
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText("Choose a compatible model or runtime to save."),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
  });

  it("keeps a saved agent's dedicated runtime when it is switched off", async () => {
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "agentRuntime") as unknown as typeof useFeature,
    );
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });
    useAgentRuntimePreflightMock.mockReturnValue({
      data: {
        ready: false,
        incompatible: "This Agent Runtime image expects the Anthropic API.",
        missing: [],
        misconfigured: [],
      },
    } as never);
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "gemini-key",
          modelId: "gemini-model",
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["runtime"]}
        activeSection="runtime"
      />,
    );

    await screen.findByText("Choose a compatible model or runtime to save.");
    await user.click(screen.getByRole("button", { name: "Disable runtime" }));

    // Nothing changed: the runtime stays, and so does what it needs.
    expect(
      screen.getByText("Choose a compatible model or runtime to save."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
  });

  it("requires an image and a command before saving a runtime newly enabled on an existing agent", async () => {
    vi.mocked(useFeature).mockImplementation(
      ((flag: string) =>
        flag === "agentRuntime") as unknown as typeof useFeature,
    );
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{ ...baseAgent, runtime: null }}
        sections={["runtime"]}
        activeSection="runtime"
      />,
    );

    // Enabling a runtime prefills no image and no command.
    await user.click(screen.getByRole("button", { name: "Enable runtime" }));
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Set runtime image and command" }),
    );
    expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody()).toMatchObject({
      runtime: { image: "example.com/custom:v1", command: ["my-agent"] },
    });
  });

  it("blocks an Anthropic runtime when the inherited organization model is Gemini", async () => {
    useOrganizationDefaultModelMock.mockReturnValue({
      autoRouters: [],
      label: "Google · Gemini 2.5 Pro",
      model: {
        dbId: "gemini-default",
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        provider: "gemini",
        capabilities: { supportedEndpoints: null },
        isFree: false,
      },
    } as never);

    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: null,
          modelId: null,
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    expect(
      await screen.findByText("Choose a compatible model or runtime to save."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
  });

  test.each([
    "tools",
    "advanced",
  ] as const)("shows recovery guidance beside Save on the %s-only form", async (section) => {
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "gemini-key",
          modelId: "gemini-model",
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={[section]}
        activeSection={section}
      />,
    );

    expect(
      await screen.findByText("Choose a compatible model or runtime to save."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
  });

  it("shows recovery guidance on a standalone advanced page", async () => {
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "gemini-key",
          modelId: "gemini-model",
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["advanced"]}
      />,
    );

    expect(
      await screen.findByText("Choose a compatible model or runtime to save."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();
  });

  it("clears the model when a newly selected key has no runtime-compatible models", async () => {
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Gemini key",
          provider: "gemini",
          scope: "personal",
          bestModelId: "gemini-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        gemini: [
          {
            dbId: "gemini-model",
            id: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            provider: "gemini",
            isFree: false,
          },
        ],
      },
    });

    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: null,
          modelId: null,
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
  });

  it("defers key-driven model selection until the model catalog arrives", async () => {
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "model-1",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({ modelsByProvider: {} });
    const user = userEvent.setup();
    const view = render(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();

    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "model-1",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["configuration"]}
      />,
    );

    expect(await screen.findByTestId("selected-model")).toHaveTextContent(
      "model-1",
    );
    expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
  });

  it("does not let a delayed catalog subscription put a model on a company connection picked since", async () => {
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "chatgpt-key",
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          bestModelId: "subscription-model",
          subscriptionKind: "chatgpt",
        },
        {
          id: "key-1",
          name: "OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "regular-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({ modelsByProvider: {} });
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const codex = getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
      (template) => template.id === "codex",
    );
    const user = userEvent.setup();
    const view = render(
      <AgentForm
        agentType="agent"
        initialRuntimeId="codex"
        initialValues={codex?.initialValues}
        sections={["configuration"]}
      />,
    );

    // Until someone chooses, the creator's own subscription is taken.
    expect(
      screen.getByRole("button", { name: /^Accounts that can run it/ }),
    ).toHaveTextContent("Connected");
    // The company key's connection is picked in its card, once it is ticked.
    expect(
      screen.queryByRole("button", { name: "Pick API key" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: /A company API key/ }),
    );
    expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "subscription-model",
            id: "claude-looking-id",
            displayName: "Subscription model",
            provider: "openai",
            isFree: false,
          },
          {
            dbId: "regular-model",
            id: "gemini-looking-id",
            displayName: "Regular model",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    view.rerender(
      <AgentForm
        agentType="agent"
        initialRuntimeId="codex"
        initialValues={codex?.initialValues}
        sections={["configuration"]}
      />,
    );

    // The connection is set alone: its model is picked after it, or left
    // to each person. Neither the subscription's model nor the key's best
    // one is taken for it.
    expect(
      await screen.findByText(
        "Every run uses this connection. Each person picks their model on the agent's page, unless you set one here.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
  });

  it("limits the company key of Codex and Grok Build to their own vendor but leaves OpenCode's same protocol provider-neutral", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "openai-model",
        },
      ],
    });
    const template = (id: "codex" | "grok" | "opencode") =>
      getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
        (candidate) => candidate.id === id,
      );
    const renderRuntime = (id: "codex" | "grok" | "opencode") =>
      render(
        <AgentForm
          agentType="agent"
          initialRuntimeId={id}
          initialValues={template(id)?.initialValues}
          sections={["configuration"]}
        />,
      );
    const companyKeyWay = () =>
      screen.getByRole("checkbox", { name: /A company API key/ });
    const user = userEvent.setup();

    // Codex runs its company key on OpenAI, beside ChatGPT subscriptions. A
    // creator with no ChatGPT of their own starts with both ways open.
    const codex = renderRuntime("codex");
    await waitFor(() => expect(companyKeyWay()).toBeChecked());
    expect(screen.getByTestId("runtime-provider-filter")).toHaveTextContent(
      '{"gemini":false,"openai":true,"anthropic":false,"bedrock":false,"xai":false}',
    );
    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    expect(await screen.findByTestId("runtime-model-filter")).toHaveTextContent(
      '{"gemini":false,"openai":true,"anthropic":false,"bedrock":false}',
    );
    codex.unmount();

    // Grok Build could call any provider, but its company key is an xAI one,
    // beside SuperGrok subscriptions.
    const grok = renderRuntime("grok");
    await user.click(companyKeyWay());
    expect(screen.getByTestId("runtime-provider-filter")).toHaveTextContent(
      '{"gemini":false,"openai":false,"anthropic":false,"bedrock":false,"xai":true}',
    );
    // A key added from the card is selected at once, so only an xAI key can
    // be added there.
    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    expect(screen.getByTestId("create-key-allowed-providers").textContent).toBe(
      "xai",
    );
    grok.unmount();

    // OpenCode has no subscription of its own: any provider it can call.
    renderRuntime("opencode");
    expect(screen.getByTestId("runtime-provider-filter")).toHaveTextContent(
      '{"gemini":true,"openai":true,"anthropic":true,"bedrock":true,"xai":true}',
    );
    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    expect(await screen.findByTestId("runtime-model-filter")).toHaveTextContent(
      '{"gemini":true,"openai":true,"anthropic":true,"bedrock":true}',
    );
  });

  it("keeps Claude Bedrock keys visible while filtering non-Claude Bedrock models", async () => {
    const runtime = {
      image: "example.com/coding-agent:latest",
      command: ["archestra-claude-code"],
      claudeCode: { authentication: "provider" as const },
      inferenceProtocol: "anthropic" as const,
      backend: "kubernetes" as const,
      steerMode: "pipe" as const,
      privileged: false,
      environment: null,
      credentials: null,
      ttlHours: null,
      maxCostUsd: null,
      idleTimeoutMinutes: null,
    };
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        initialValues={{ runtime }}
        sections={["configuration"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pick API key" }));

    expect(
      await screen.findByTestId("runtime-provider-filter"),
    ).toHaveTextContent(
      '{"gemini":false,"openai":false,"anthropic":true,"bedrock":true,"xai":false}',
    );
    expect(screen.getByTestId("runtime-model-filter")).toHaveTextContent(
      '{"gemini":false,"openai":false,"anthropic":true,"bedrock":true}',
    );
    expect(
      screen.getByTestId("runtime-bedrock-model-filter"),
    ).toHaveTextContent('{"claude":true,"nova":false}');
  });

  it("skips a Responses-only best model for a Chat Completions runtime", async () => {
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "OpenAI key",
          provider: "openai",
          scope: "personal",
          bestModelId: "responses-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "responses-model",
            id: "gpt-5.3-codex",
            displayName: "Codex",
            provider: "openai",
            isFree: false,
          },
          {
            dbId: "chat-model",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });

    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: null,
          modelId: null,
          runtime: {
            image: "example.com/coding-agent:latest",
            command: null,
            inferenceProtocol: "openai_chat",
            backend: "kubernetes",
            steerMode: "pipe",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pick API key" }));
    expect(screen.getByTestId("selected-model")).toHaveTextContent(
      "chat-model",
    );
  });

  it("writes only the channel assignments from a messaging-only surface", async () => {
    // Channel assignments save through their own endpoint. A surface showing
    // just them displays no field of the agent record, so the record's PUT
    // would carry an empty body — which still forks a config version and
    // writes an audit record for an edit nobody made.
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={baseAgent}
        sections={["messaging"]}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Mark channel changes dirty" }),
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(saveChannelChangesMock).toHaveBeenCalled());
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("sends the agent's own network policy once it is edited", async () => {
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          networkPolicy: {
            egressMode: "restricted",
            domainPreset: "none",
            allowedDomains: ["api.example.com"],
            allowedCidrs: [],
          },
        }}
        sections={["advanced"]}
      />,
    );

    const domains = await screen.findByLabelText("Allowed domains");
    expect(domains).toHaveValue("api.example.com");
    fireEvent.change(domains, {
      target: { value: "api.example.com\nregistry.example.com" },
    });
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().networkPolicy).toEqual({
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["api.example.com", "registry.example.com"],
      allowedCidrs: [],
    });
  });

  it("sends the advanced step's own fields, and nothing the step does not show", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const user = userEvent.setup();
    render(
      <AgentForm agentType="agent" agent={baseAgent} sections={["advanced"]} />,
    );

    await screen.findByText("Suggested prompts");
    expect(screen.queryByTestId("agent-runtime")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("Button Label"), "Summarize");
    await user.type(
      screen.getByLabelText("Suggested prompt"),
      "Summarize recent changes",
    );
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().suggestedPrompts).toEqual([
      { summaryTitle: "Summarize", prompt: "Summarize recent changes" },
    ]);
    expect(Object.keys(savedBody()).sort()).toEqual([
      "identityProviderId",
      "labels",
      // The environment and the suggested prompts are edited on this step, so
      // they are written with it. `environmentId` only travels when it moved.
      "suggestedPrompts",
    ]);
  });

  it("describes the environment's sandbox and network egress for an agent with no dedicated runtime", async () => {
    // baseAgent.runtime is null — this agent has no dedicated Agent
    // Runtime, but it still runs its tools (including bash) through the
    // sandbox and is subject to its network egress controls, so the
    // description should mention that regardless.
    renderAdvanced();

    await screen.findByRole("heading", { name: "Environment" });
    expect(
      screen.getByText(
        "The environment for this agent's sandbox (runtime and network egress) and the tools and knowledge sources it can use.",
      ),
    ).toBeInTheDocument();
  });

  it("describes the environment's sandbox and network egress for an agent with a dedicated runtime", async () => {
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          runtime: {
            ...defaultAgentRuntime(),
            image: "example.com/runtime:latest",
          },
        }}
        sections={["advanced"]}
      />,
    );

    await screen.findByRole("heading", { name: "Environment" });
    expect(
      screen.getByText(
        "The environment for this agent's sandbox (runtime and network egress) and the tools and knowledge sources it can use.",
      ),
    ).toBeInTheDocument();
    // Agent Runtime is not limited to coding agents, so the description
    // should not single out a "code sandbox".
    expect(screen.queryByText(/code sandbox/)).not.toBeInTheDocument();
  });

  it("keeps describing the environment's sandbox as a new agent's own runtime choice changes, not a global or existing-agent setting", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const user = userEvent.setup();
    render(<AgentForm agentType="agent" submitEnabled={false} />);

    // No runtime picked yet for this to-be-created agent, and the org-wide
    // agentRuntime feature is enabled — neither changes the description.
    await screen.findByRole("heading", { name: "Environment" });
    expect(
      screen.getByText(
        "The environment for this agent's sandbox (runtime and network egress) and the tools and knowledge sources it can use.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "OpenCode" }));

    expect(
      screen.getByText(
        "The environment for this agent's sandbox (runtime and network egress) and the tools and knowledge sources it can use.",
      ),
    ).toBeInTheDocument();
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
    renderAdvanced();

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
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "model-1",
            id: "gpt-4o",
            displayName: "GPT-4o",
            provider: "openai",
            isFree: false,
          },
        ],
      },
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

  it("automatically uses an existing ChatGPT subscription for the Codex catalog runtime", async () => {
    const user = userEvent.setup();
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "chatgpt-subscription",
          name: "ChatGPT Subscription",
          provider: "openai",
          scope: "personal",
          bestModelId: "codex-model",
          subscriptionKind: "chatgpt",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "codex-model",
            id: "gpt-5.3-codex",
            displayName: "Codex",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });

    render(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialValues={{
          ...getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
            (template) => template.id === "codex",
          )?.initialValues,
        }}
      />,
    );

    const createButton = await screen.findByRole("button", {
      name: /create/i,
    });
    await waitFor(() => expect(createButton).not.toBeDisabled());
    await user.click(createButton);

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      llmApiKeyId: "chatgpt-subscription",
      modelId: "codex-model",
    });
  });

  it("does not let a Codex catalog runtime fall back to an API key", async () => {
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "usage-key",
          name: "OpenAI API key",
          provider: "openai",
          scope: "org",
          bestModelId: "usage-model",
          subscriptionKind: null,
        },
      ],
    });

    render(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialValues={{
          ...getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
            (template) => template.id === "codex",
          )?.initialValues,
        }}
      />,
    );

    expect(
      await screen.findByText("ChatGPT Subscription required"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Sign in with ChatGPT" }),
    ).toHaveAttribute("href", "/llm/model-providers?connect=chatgpt");
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });

  it("preserves the entered identity and instructions while switching runtime and reapplying the Codex subscription gate", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const user = userEvent.setup();
    const claude = getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
      (template) => template.id === "claude-code",
    );
    render(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialRuntimeId="claude-code"
        initialValues={claude?.initialValues}
      />,
    );

    const name = screen.getByPlaceholderText("Enter agent name");
    await user.clear(name);
    await user.paste("Incident helper");
    // The variable editor beside it has a Description field of its own.
    const description = document.getElementById(
      "agentDescription",
    ) as HTMLTextAreaElement;
    await user.clear(description);
    await user.paste("Investigate build failures");
    const instructions = screen.getByRole("textbox", { name: "Instructions" });
    await user.clear(instructions);
    await user.paste("Start with the failing build logs.");

    // Without a ChatGPT subscription of their own the creator starts with
    // both ways open; subscriptions alone wait for theirs.
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /A company API key/ }),
      ).toBeChecked(),
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    await user.click(
      screen.getByRole("checkbox", { name: /A company API key/ }),
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("img", {
        name: "Connect your ChatGPT subscription before creating the agent",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(
      screen.queryByRole("img", {
        name: "Connect your ChatGPT subscription before creating the agent",
      }),
    ).not.toBeInTheDocument();
    // Back on Codex the start is applied again: both ways open.
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("radio", { name: "OpenCode" }));

    expect(name).toHaveValue("Incident helper");
    expect(description).toHaveValue("Investigate build failures");
    expect(instructions).toHaveValue("Start with the failing build logs.");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      name: "Incident helper",
      description: "Investigate build failures",
      systemPrompt: "Start with the failing build logs.",
      runtime: {
        command: ["archestra-opencode"],
        inferenceProtocol: "openai_responses",
      },
    });
  });

  it("unblocks a selected Codex runtime when a new ChatGPT connection arrives", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            dbId: "codex-model",
            id: "gpt-5.3-codex",
            displayName: "Codex",
            provider: "openai",
            isFree: false,
          },
        ],
      },
    });
    const user = userEvent.setup();
    const initialValues = { name: "Codex helper" };
    const { rerender } = render(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialValues={initialValues}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
    // Subscriptions alone, which wait for the creator's own ChatGPT.
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /A company API key/ }),
      ).toBeChecked(),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /A company API key/ }),
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("img", {
        name: "Connect your ChatGPT subscription before creating the agent",
      }),
    ).toBeVisible();

    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "new-subscription",
          name: "ChatGPT subscription",
          provider: "openai",
          scope: "personal",
          bestModelId: "codex-model",
          subscriptionKind: "chatgpt",
        },
      ],
    });
    rerender(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialValues={initialValues}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("img", {
        name: "Connect your ChatGPT subscription before creating the agent",
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      llmApiKeyId: "new-subscription",
      modelId: "codex-model",
      runtime: { command: ["archestra-codex"] },
    });
  });

  describe("a new Claude agent starts on the account its runtime names", () => {
    const companyKeyWay = () =>
      screen.getByRole("checkbox", { name: /A company API key/ });
    const subscriptionWay = () =>
      screen.getByRole("checkbox", {
        name: /Each person's Claude subscription/,
      });
    // What the creator may configure, with a default connection of their own
    // and one of the organization's that the runtime can call.
    beforeEach(() => {
      vi.mocked(useFeature).mockImplementation(
        (flag) => flag === "agentRuntime",
      );
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [
          {
            id: "org-default",
            name: "Organization Anthropic",
            provider: "anthropic",
            scope: "org",
            isPrimary: true,
            bestModelId: "claude-model",
          },
          {
            id: "my-default",
            name: "My Anthropic",
            provider: "anthropic",
            scope: "personal",
            isPrimary: true,
            bestModelId: "claude-model",
          },
        ],
      });
      useLlmModelsByProviderMock.mockReturnValue({
        modelsByProvider: {
          anthropic: [
            {
              dbId: "claude-model",
              id: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              provider: "anthropic",
              isFree: false,
            },
          ],
        },
      });
    });
    const claudeCode = getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
      (template) => template.id === "claude-code",
    )?.initialValues;
    /** The built-in Claude Code runtime, set to `authentication` if given. */
    const renderNewAgent = (authentication?: "provider" | "subscription") =>
      render(
        <AgentForm
          agentType="agent"
          sections={["configuration"]}
          initialRuntimeId="claude-code"
          initialValues={
            claudeCode && {
              ...claudeCode,
              runtime: claudeCode.runtime && {
                ...claudeCode.runtime,
                ...(authentication && {
                  claudeCode: {
                    ...claudeCode.runtime.claudeCode,
                    authentication,
                  },
                }),
              },
            }
          }
        />,
      );

    it("on each person's subscription: that card alone, whatever default connection the creator has", async () => {
      const user = userEvent.setup();
      // The built-in runtime's own setting is each person's subscription.
      renderNewAgent();

      await waitFor(() => expect(subscriptionWay()).toBeChecked());
      expect(companyKeyWay()).not.toBeChecked();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(/Name/), "Subscription agent");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "Create" }));
      await waitFor(() => expect(createAgent).toHaveBeenCalled());
      // What ticking only the subscription card saves.
      expect(createAgent.mock.calls[0][0]).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
        runtime: {
          accountLock: "subscription",
          claudeCode: { authentication: "subscription" },
        },
      });
    });

    it("with no account named on a custom image: the company card, with no connection picked for it", async () => {
      render(
        <AgentForm
          agentType="agent"
          sections={["configuration"]}
          initialRuntimeId="custom"
          initialValues={{
            runtime: {
              image: "example.com/claude-code:latest",
              command: ["custom-claude-entrypoint"],
              inferenceProtocol: "anthropic",
              backend: "kubernetes",
              steerMode: "tmux_keys",
              privileged: false,
              environment: null,
              credentials: null,
              ttlHours: null,
              maxCostUsd: null,
              idleTimeoutMinutes: null,
            },
          }}
        />,
      );

      // An image that does not declare Claude Code has only the company key,
      // and nothing ticks the subscription or picks a connection for it.
      expect(companyKeyWay()).toBeChecked();
      expect(subscriptionWay()).not.toBeChecked();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(companyKeyWay()).toBeChecked();
      expect(subscriptionWay()).not.toBeChecked();
      expect(screen.getByTestId("selected-model")).toHaveTextContent("");
    });

    it("on a custom image whose settings store a Claude subscription and no rule: the company card, as every agent there ran", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          sections={["configuration"]}
          initialRuntimeId="custom"
          initialValues={{
            runtime: {
              image: "example.com/claude-code:latest",
              command: ["custom-claude-entrypoint"],
              inferenceProtocol: "anthropic",
              // What the old runtime dialog stored, which a custom image
              // never ran on.
              claudeCode: { authentication: "subscription" },
              backend: "kubernetes",
              steerMode: "tmux_keys",
              privileged: false,
              environment: null,
              credentials: null,
              ttlHours: null,
              maxCostUsd: null,
              idleTimeoutMinutes: null,
            },
          }}
        />,
      );

      await waitFor(() => expect(companyKeyWay()).toBeChecked());
      expect(subscriptionWay()).not.toBeChecked();

      // Its creator may still open the subscription way themselves.
      await user.click(subscriptionWay());
      expect(subscriptionWay()).toBeChecked();
    });

    describe("on a runtime whose rule names no account", () => {
      /** May use the runtime, not configure it. */
      const useOnly = (name: string) => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: false,
          readOnlyBy: name,
        };
      };
      const create = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(screen.getByLabelText(/Name/), "Their agent");
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        return createAgent.mock.calls[0][0];
      };

      it("starts the built-in runtime's agent on the subscription the runtime comes with, whatever default connection the creator has", async () => {
        // Someone who may configure it, with a default connection.
        runtimePermissions.current = {
          canChange: true,
          canConfigure: true,
          readOnlyBy: null,
        };
        const user = userEvent.setup();
        renderNewAgent("subscription");

        await waitFor(() => expect(subscriptionWay()).toBeChecked());
        expect(companyKeyWay()).not.toBeChecked();
        expect(subscriptionWay()).not.toHaveAttribute("aria-readonly");
        expect(await create(user)).toMatchObject({
          llmApiKeyId: null,
          runtime: { accountLock: "subscription" },
        });
      });

      it("starts someone who may only use the built-in runtime on that card too, with nothing read-only", async () => {
        useOnly("Claude Code");
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        renderNewAgent("subscription");

        await waitFor(() => expect(subscriptionWay()).toBeChecked());
        expect(companyKeyWay()).not.toBeChecked();
        expect(subscriptionWay()).not.toHaveAttribute("aria-readonly");
        expect(
          screen.queryByText("Select at least one option."),
        ).not.toBeInTheDocument();
        // Nothing says the accounts need `configure` on the runtime.
        expect(
          screen.queryByText(/can change which accounts run it/),
        ).not.toBeInTheDocument();
        expect(
          screen.getByText("Set by the Claude Code runtime").parentElement,
        ).toHaveTextContent(
          "Environment, credentials, ports and accounts stay this agent's own.",
        );
      });

      it("lets someone who may only use a custom runtime with no account choose its agent's accounts", async () => {
        useOnly("Team runtime");
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId="custom"
            initialValues={{
              runtime: {
                image: "example.com/claude-code:latest",
                command: ["custom-claude-entrypoint"],
                inferenceProtocol: "anthropic",
                backend: "kubernetes",
                steerMode: "tmux_keys",
                privileged: false,
                environment: null,
                credentials: null,
                ttlHours: null,
                maxCostUsd: null,
                idleTimeoutMinutes: null,
              },
            }}
          />,
        );

        // As for someone who configures it: the company card, open to change.
        expect(companyKeyWay()).toBeChecked();
        expect(subscriptionWay()).not.toBeChecked();
        expect(companyKeyWay()).not.toHaveAttribute("aria-readonly");
        expect(
          screen.queryByText(/can change which accounts run it/),
        ).not.toBeInTheDocument();

        await user.click(subscriptionWay());
        await user.click(companyKeyWay());
        expect(subscriptionWay()).toBeChecked();
        expect(companyKeyWay()).not.toBeChecked();
        expect(await create(user)).toMatchObject({
          runtime: {
            accountLock: "subscription",
            claudeCode: { authentication: "subscription" },
          },
        });
      });
    });
  });

  it("shows an agent saved before people could choose on a custom Claude image on the company API key it runs on, and saves its Claude account untouched", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    useAvailableLlmProviderApiKeysMock.mockReturnValue({
      data: [
        {
          id: "key-1",
          name: "Anthropic key",
          provider: "anthropic",
          scope: "org",
          bestModelId: "claude-model",
        },
      ],
    });
    useLlmModelsByProviderMock.mockReturnValue({
      modelsByProvider: {
        anthropic: [
          {
            dbId: "claude-model",
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet",
            provider: "anthropic",
            isFree: false,
          },
        ],
      },
    });
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "key-1",
          modelId: "claude-model",
          runtime: {
            image: "example.com/claude-code:latest",
            command: ["custom-claude-entrypoint"],
            claudeCode: {
              authentication: "subscription",
              model: "opus",
            },
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "tmux_keys",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    expect(screen.getByText("Accounts that can run it")).toBeVisible();
    // Saved before people could choose: it runs only the way it always ran.
    // A custom image ran every agent on its company API key, whatever Claude
    // account the agent stored.
    expect(
      screen.getByRole("checkbox", { name: /A company API key/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /Each person's Claude subscription/,
      }),
    ).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    // Nothing changed its accounts, so its stored runtime is not sent.
    expect(savedBody().runtime).toBeUndefined();
  });

  describe("a connection an agent saved before people could choose stores without a model", () => {
    const anthropicKey = {
      id: "anthropic-key",
      name: "Anthropic key",
      provider: "anthropic",
      scope: "org",
      bestModelId: "claude-model",
    };
    const savedAgent = (accountLock?: null) => ({
      ...baseAgent,
      llmApiKeyId: "anthropic-key",
      modelId: null,
      runtime: {
        image: "example.com/coding-agent:latest",
        command: ["my-agent"],
        inferenceProtocol: "openai_chat" as const,
        backend: "kubernetes" as const,
        steerMode: "pipe" as const,
        privileged: false,
        environment: null,
        credentials: null,
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
        ...(accountLock !== undefined && { accountLock }),
      },
    });
    const organizationDefault = (
      model: { provider: "openai"; displayName: string } | null,
    ) =>
      useOrganizationDefaultModelMock.mockReturnValue({
        autoRouters: [],
        autoRoutedTiers: null,
        defaultAutoRouterId: null,
        label: model?.displayName ?? null,
        model: model && {
          dbId: "default-model",
          id: "gpt-5",
          displayName: model.displayName,
          provider: model.provider,
          capabilities: { supportedEndpoints: null },
          isFree: false,
        },
      } as never);
    beforeEach(() => {
      vi.mocked(useFeature).mockImplementation(
        (flag) => flag === "agentRuntime",
      );
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [anthropicKey],
      });
    });

    it("says it is not used where the organization's default model is of another provider", () => {
      organizationDefault({ provider: "openai", displayName: "GPT-5" });
      render(
        <AgentForm
          agentType="agent"
          agent={savedAgent()}
          sections={["configuration"]}
        />,
      );

      expect(
        screen.getByText(
          "This connection is not used: every run uses the organization's default model, GPT-5. Pick a model to run on this connection.",
        ),
      ).toBeVisible();
    });

    it("says when it is used where the organization sets no default model", () => {
      organizationDefault(null);
      render(
        <AgentForm
          agentType="agent"
          agent={savedAgent()}
          sections={["configuration"]}
        />,
      );

      expect(
        screen.getByText(
          "Every run uses the best available model, on this connection only where it serves that model. Pick a model to run on this connection.",
        ),
      ).toBeVisible();
    });

    it("is every run's connection on an agent saved with its accounts", () => {
      organizationDefault({ provider: "openai", displayName: "GPT-5" });
      render(
        <AgentForm
          agentType="agent"
          agent={savedAgent(null)}
          sections={["configuration"]}
        />,
      );

      expect(
        screen.getByText(
          "Every run uses this connection. Each person picks their model on the agent's page, unless you set one here.",
        ),
      ).toBeVisible();
      expect(screen.queryByText(/This connection is not used/)).toBeNull();
    });
  });

  it("starts a custom Claude command without Claude settings on a company API key", () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          runtime: {
            image: "example.com/claude-code:latest",
            command: ["custom-claude-entrypoint"],
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "tmux_keys",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    // An image that does not declare Claude Code has only the company key.
    expect(
      screen.getByRole("checkbox", { name: /A company API key/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /Each person's Claude subscription/,
      }),
    ).not.toBeChecked();
  });

  it("omits runtime from the configuration save when the caller may not use the agent's runtime even if claudeCode.authentication is subscription on a custom command", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    runtimePermissions.current = {
      canChange: false,
      canConfigure: false,
      readOnlyBy: null,
    };
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "key-1",
          modelId: "claude-model",
          runtime: {
            image: "example.com/claude-code:latest",
            command: ["custom-claude-entrypoint"],
            claudeCode: {
              authentication: "subscription",
              model: "opus",
            },
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "tmux_keys",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalled());
    expect(savedBody().runtime).toBeUndefined();
  });

  it("does not treat a maintained non-Claude harness on the Anthropic protocol as Claude Code", () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    render(
      <AgentForm
        agentType="agent"
        agent={{
          ...baseAgent,
          llmApiKeyId: "key-1",
          modelId: "claude-model",
          runtime: {
            image: "example.com/opencode:latest",
            command: ["archestra-opencode"],
            inferenceProtocol: "anthropic",
            backend: "kubernetes",
            steerMode: "tmux_keys",
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            maxCostUsd: null,
            idleTimeoutMinutes: null,
          },
        }}
        sections={["configuration"]}
      />,
    );

    // Its accounts are a runtime's, not Claude Code's: the company key alone,
    // with no Claude subscription to allow and nothing said about its image.
    const accounts = screen.getByRole("group", {
      name: "Accounts that can run it",
    });
    expect(within(accounts).getByText("A company API key")).toBeVisible();
    expect(
      screen.queryByText(/Each person's Claude subscription/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Choose a personal subscription only for an image/),
    ).not.toBeInTheDocument();
    expect(
      within(accounts).getByRole("button", { name: "Pick API key" }),
    ).toBeVisible();
  });

  it("marks the image row until a container image and command are supplied", async () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const user = userEvent.setup();
    render(
      <AgentForm
        agentType="agent"
        sections={["configuration"]}
        initialValues={{ name: "Custom runtime" }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Custom image" }));
    expect(screen.getByLabelText(/Container image/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^Image/ }));
    expect(screen.queryByLabelText(/Container image/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Set a container image before creating the agent",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Image/ }));
    await user.type(
      screen.getByLabelText(/Container image/),
      "example.com/custom:v1",
    );
    // The image alone is not enough: nothing supplies a default command.
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("img", {
        name: "Set a command before creating the agent",
      }),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Command"), "my-agent");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(
      screen.queryByRole("img", {
        name: /^Set a (container image|command) before creating the agent$/,
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      runtime: { image: "example.com/custom:v1", command: ["my-agent"] },
    });
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
    renderAdvanced();

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
    renderAdvanced();

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
    renderAdvanced();

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

  it("creates an agent directly from Configuration with untouched setup defaults", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(
      <AgentForm
        agentType="agent"
        activeSection="configuration"
        submitEnabled
        onCreated={onCreated}
      />,
    );
    await user.type(
      screen.getByPlaceholderText("Enter agent name"),
      "Quick setup agent",
    );
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        id: "created-agent",
        name: "New Agent",
        hasRuntime: false,
      }),
    );
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      name: "Quick setup agent",
      accessAllTools: true,
      initialGrants: [],
    });
  });

  it("does not ask for a runtime again once the catalog picked the built-in agent", () => {
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    render(
      <AgentForm
        agentType="agent"
        activeSection="configuration"
        onChangeRuntimeTemplate={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId(E2eTestId.AgentRuntimePicker),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Claude Code" })).toBeNull();
  });

  it("keeps every step's editors mounted while one step shows, and submits only when told to", async () => {
    // The create wizard walks one form across its steps: what a hidden step
    // holds (the tools picked on it) must survive the step change, and Enter
    // on an earlier step must not create the record.
    vi.mocked(useFeature).mockImplementation((flag) => flag === "agentRuntime");
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentForm
        agentType="agent"
        activeSection="configuration"
        submitEnabled={false}
      />,
    );

    const runtimeSection = screen.getByTestId(E2eTestId.AgentRuntimePicker);
    expect(runtimeSection).toBeVisible();
    await user.click(
      within(runtimeSection).getByRole("radio", { name: "Archestra" }),
    );

    const toolsEditor = await screen.findByText("Mock Tools Editor");
    expect(panelOf(toolsEditor)).toHaveClass("hidden");
    expect(
      panelOf(screen.getByPlaceholderText("Enter agent name")),
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
    expect(panelOf(screen.getByText("Mock Tools Editor"))).not.toHaveClass(
      "hidden",
    );
    // Same mount: the name typed on the first step is still there.
    expect(screen.getByPlaceholderText("Enter agent name")).toHaveValue(
      "New Agent",
    );

    rerender(
      <AgentForm agentType="agent" activeSection="advanced" submitEnabled />,
    );
    expect(
      panelOf(screen.getByRole("heading", { name: "Suggested prompts" })),
    ).not.toHaveClass("hidden");
    expect(panelOf(runtimeSection.parentElement as HTMLElement)).toHaveClass(
      "hidden",
    );
    expect(
      screen.queryByRole("heading", { name: "Agent Runtime" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    const body = createAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "New Agent",
      runtime: null,
      labels: [],
      suggestedPrompts: [],
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

  it("creates an internal agent with the skill policy staged in the form", async () => {
    const skill = {
      reference: { source: "native" as const, skillId: "skill-1" },
      name: "incident-response",
      activationName: "incident-response",
      description: "Respond to incidents",
      scope: "org" as const,
      providerName: null,
    };
    useAgentActivationSkillsMock.mockReturnValue({
      data: {
        enabled: true,
        data: [skill],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
    });
    const user = userEvent.setup();
    render(<AgentForm agentType="agent" />);

    await user.type(
      screen.getByPlaceholderText("Enter agent name"),
      "New Agent",
    );
    const section = (
      await screen.findByRole("heading", { name: "Skills" })
    ).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("radio", { name: /^Manual/ }));
    await user.click(
      within(section).getByRole("button", {
        name: "Add incident-response",
      }),
    );
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      activationSkillPolicy: {
        mode: "manual",
        allowedReferences: [skill.reference],
        excludedReferences: [],
      },
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

  describe("account lock", () => {
    // Null is "each person chooses"; "none" leaves the lock out, as on an
    // agent saved before people could choose.
    const lockRuntime = (
      command: string[],
      accountLock?: "subscription" | "key" | "none",
    ) => ({
      image: "example.com/coding-agent:latest",
      command,
      inferenceProtocol: "openai_responses" as const,
      backend: "kubernetes" as const,
      steerMode: "pipe" as const,
      privileged: false,
      environment: null,
      credentials: null,
      ttlHours: null,
      maxCostUsd: null,
      idleTimeoutMinutes: null,
      ...(accountLock !== "none" && { accountLock: accountLock ?? null }),
    });
    const companyKey = {
      id: "openai-key",
      name: "Company OpenAI",
      provider: "openai",
      scope: "org",
      bestModelId: "openai-model",
    };
    const chatgptKey = {
      id: "chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      bestModelId: "openai-model",
      subscriptionKind: "chatgpt",
    };
    const lockedAgent = (params: {
      command?: string[];
      lock?: "subscription" | "key" | "none";
      llmApiKeyId?: string | null;
    }) => ({
      ...baseAgent,
      llmApiKeyId:
        params.llmApiKeyId === undefined ? "openai-key" : params.llmApiKeyId,
      modelId: "openai-model",
      runtime: lockRuntime(params.command ?? ["my-agent"], params.lock),
    });
    // The runtimes with a subscription of their own: only they have two
    // accounts to tick. Codex runs on ChatGPT, Grok Build on SuperGrok.
    const codex = ["archestra-codex"];
    const xaiKey = {
      id: "xai-key",
      name: "Company xAI",
      provider: "xai",
      scope: "org",
      bestModelId: "grok-model",
    };
    const superGrokKey = {
      id: "supergrok-key",
      name: "SuperGrok",
      provider: "xai",
      scope: "personal",
      bestModelId: "grok-model",
      subscriptionKind: "x-premium",
    };
    const grokAgent = (params: {
      lock?: "subscription" | "key" | "none";
      llmApiKeyId?: string;
    }) => ({
      ...baseAgent,
      llmApiKeyId: params.llmApiKeyId ?? "xai-key",
      modelId: "grok-model",
      runtime: {
        ...lockRuntime(["archestra-grok"], params.lock),
        inferenceProtocol: "openai_chat" as const,
      },
    });
    const withGrokKeys = () => {
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [xaiKey, superGrokKey],
      });
      useLlmModelsByProviderMock.mockReturnValue({
        modelsByProvider: {
          xai: [
            {
              dbId: "grok-model",
              id: "grok-4",
              displayName: "Grok 4",
              provider: "xai",
              isFree: false,
            },
          ],
        },
      });
    };
    const subscriptionWay = () =>
      screen.getByRole("checkbox", {
        name: /Each person's ChatGPT subscription/,
      });
    const superGrokWay = () =>
      screen.getByRole("checkbox", {
        name: /Each person's SuperGrok subscription/,
      });
    const companyKeyWay = () =>
      screen.getByRole("checkbox", { name: /A company API key/ });

    beforeEach(() => {
      vi.mocked(useFeature).mockImplementation(
        ((flag: string) =>
          flag === "agentRuntime") as unknown as typeof useFeature,
      );
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [companyKey, chatgptKey],
      });
      useLlmModelsByProviderMock.mockReturnValue({
        modelsByProvider: {
          openai: [
            {
              dbId: "openai-model",
              id: "gpt-5",
              displayName: "GPT-5",
              provider: "openai",
              isFree: false,
            },
          ],
        },
      });
    });

    it("ticks both ways for an unlocked agent and locks it to the company key when the subscription is unticked", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex })}
          sections={["configuration"]}
        />,
      );
      expect(await screen.findByText("Accounts that can run it")).toBeVisible();
      expect(subscriptionWay()).toBeChecked();
      expect(companyKeyWay()).toBeChecked();
      // The company key's two fields sit in its card; nothing else picks a
      // key or a model for a runtime agent.
      expect(
        within(
          companyKeyWay().closest("label")?.parentElement as HTMLElement,
        ).getByTestId("selected-model"),
      ).toHaveTextContent("openai-model");
      expect(screen.getAllByTestId("selected-model")).toHaveLength(1);
      expect(
        screen.getByText(
          "Each person who runs this agent chooses their own subscription or a company API key on the agent's page.",
        ),
      ).toBeVisible();

      await user.click(subscriptionWay());
      expect(subscriptionWay()).not.toBeChecked();
      expect(companyKeyWay()).toBeChecked();
      expect(screen.getByText("Locked to a company API key")).toBeVisible();
      // The agent has a company key and model, so nothing is left to set up.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
    });

    it("shows an agent saved before people could choose on its one way, and opens it to each person's choice", async () => {
      withGrokKeys();
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={grokAgent({ lock: "none" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      // Everyone runs on its own connection today, so that is what is ticked.
      expect(superGrokWay()).not.toBeChecked();
      expect(companyKeyWay()).toBeChecked();

      await user.click(superGrokWay());
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({ accountLock: null });
    });

    it("lets both options be unticked and blocks Save until one is selected", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex, lock: "key" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      expect(subscriptionWay()).not.toBeChecked();
      await user.click(companyKeyWay());
      expect(companyKeyWay()).not.toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Select at least one option.",
      );
      expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();

      // Selecting one again clears that message.
      await user.click(subscriptionWay());
      expect(
        screen.queryByText("Select at least one option."),
      ).not.toBeInTheDocument();
      expect(subscriptionWay()).toBeChecked();
      expect(companyKeyWay()).not.toBeChecked();
    });

    it("locks an agent with a company key of its own to personal subscriptions, and drops the key no run uses any more", async () => {
      // The runtime has a subscription of its own, so the lock does not
      // depend on what the agent's own connection is.
      withGrokKeys();
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={grokAgent({})}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      await user.click(companyKeyWay());
      expect(superGrokWay()).toBeChecked();
      expect(companyKeyWay()).not.toBeChecked();
      expect(
        screen.getByText("Locked to each user's personal subscription"),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({
        accountLock: "subscription",
      });
      // Its company key and model would be nobody's: neither the runs nor
      // the agents list keep showing them.
      expect(savedBody()).toMatchObject({ llmApiKeyId: null, modelId: null });
    });

    it("lifts the ChatGPT requirement when a new Codex agent runs only on a company API key", async () => {
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [companyKey],
      });
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          sections={["configuration"]}
          initialValues={{
            ...getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
              (template) => template.id === "codex",
            )?.initialValues,
          }}
        />,
      );
      // The creator has no ChatGPT of their own: the agent starts with both
      // ways open. Beside subscriptions the company key is still what the
      // agent's own setting runs on, so the creator needs no subscription.
      await waitFor(() => expect(companyKeyWay()).toBeChecked());
      expect(subscriptionWay()).toBeChecked();
      expect(
        screen.queryByText("ChatGPT Subscription required"),
      ).not.toBeInTheDocument();
      // Subscriptions alone: the agent takes its model from its creator's.
      await user.click(companyKeyWay());
      expect(
        screen.getByText("ChatGPT Subscription required"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
      // The company key alone needs no subscription either.
      await user.click(companyKeyWay());
      await user.click(subscriptionWay());
      expect(subscriptionWay()).not.toBeChecked();
      expect(companyKeyWay()).toBeChecked();
      expect(
        screen.queryByText("ChatGPT Subscription required"),
      ).not.toBeInTheDocument();
    });

    it.each([
      ["OpenCode", ["archestra-opencode"]],
      ["a custom image", ["my-agent"]],
    ])("shows %s one company API key card with nothing to tick, and no subscription for its OpenAI key", async (_name, command) => {
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command })}
          sections={["configuration"]}
        />,
      );
      // The section is the accounts one for every runtime, never "Model".
      expect(await screen.findByText("Accounts that can run it")).toBeVisible();
      expect(screen.queryByText("Model")).not.toBeInTheDocument();
      const accounts = screen.getByRole("group", {
        name: "Accounts that can run it",
      });
      expect(within(accounts).getByText("A company API key")).toBeVisible();
      // The runtime has no subscription of its own, and an OpenAI key does
      // not bring ChatGPT's along.
      expect(screen.queryByText(/Each person's/)).not.toBeInTheDocument();
      // One account is always on: nothing to tick, and no line on what the
      // ticks amount to.
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Locked to a company API key"),
      ).not.toBeInTheDocument();
      // Its connection and model are picked in the card, and nowhere else.
      expect(
        within(accounts).getByRole("button", { name: "Pick API key" }),
      ).toBeEnabled();
      expect(within(accounts).getByTestId("selected-model")).toHaveTextContent(
        "openai-model",
      );
      expect(
        screen.getAllByRole("button", { name: "Pick API key" }),
      ).toHaveLength(1);
    });

    it("sends the key lock when the subscription is unticked and null when it is ticked again", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      await user.click(subscriptionWay());
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({ accountLock: "key" });
      unmount();

      updateAgent.mockClear();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex, lock: "key" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      expect(subscriptionWay()).not.toBeChecked();
      await user.click(subscriptionWay());
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({ accountLock: null });
    });

    it("sends the subscription lock when the company key is unticked", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex, llmApiKeyId: "chatgpt-key" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      await user.click(companyKeyWay());
      expect(
        screen.getByText("Locked to each user's personal subscription"),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({
        accountLock: "subscription",
      });
    });

    it("keeps a Codex agent's own ChatGPT subscription once it allows subscriptions alone", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex, llmApiKeyId: "chatgpt-key" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      await user.click(companyKeyWay());
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody()).not.toHaveProperty("llmApiKeyId");
    });

    it.each([
      ["becomes one with a single account", "Set runtime image and command"],
    ])("forgets that both options were unticked when the runtime %s", async (_change, button) => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ command: codex })}
          sections={["configuration", "runtime"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      await user.click(subscriptionWay());
      await user.click(companyKeyWay());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Select at least one option.",
      );
      expect(screen.getByRole("button", { name: /update/i })).toBeDisabled();

      // No boxes are left to tick, so nothing may go on waiting for one.
      await user.click(screen.getByRole("button", { name: button }));
      await waitFor(() =>
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByText("Select at least one option."),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
    });

    it("leaves a Claude agent's own account as it was when the subscription is unticked and ticked again", async () => {
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [
          {
            id: "anthropic-key",
            name: "Company Anthropic",
            provider: "anthropic",
            scope: "org",
            bestModelId: "claude-model",
          },
        ],
      });
      useLlmModelsByProviderMock.mockReturnValue({
        modelsByProvider: {
          anthropic: [
            {
              dbId: "claude-model",
              id: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              provider: "anthropic",
              isFree: false,
            },
          ],
        },
      });
      const onDirtyChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={{
            ...lockedAgent({ llmApiKeyId: "anthropic-key" }),
            modelId: "claude-model",
            runtime: {
              ...lockRuntime(["archestra-claude-code"]),
              inferenceProtocol: "anthropic" as const,
              // Each person's subscription is what a run with no choice
              // uses, beside a company key for those who choose it.
              claudeCode: { authentication: "subscription" as const },
              credentials: [
                {
                  key: "CLAUDE_CODE_OAUTH_TOKEN",
                  scope: "per_user" as const,
                  label: "Claude token",
                  required: false,
                },
              ],
            },
          }}
          sections={["configuration"]}
          onDirtyChange={onDirtyChange}
        />,
      );
      const claudeSubscriptionWay = () =>
        screen.getByRole("checkbox", {
          name: /Each person's Claude subscription/,
        });
      await screen.findByText("Accounts that can run it");
      expect(claudeSubscriptionWay()).toBeChecked();
      expect(companyKeyWay()).toBeChecked();

      await user.click(claudeSubscriptionWay());
      expect(claudeSubscriptionWay()).not.toBeChecked();
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
      await user.click(claudeSubscriptionWay());
      expect(claudeSubscriptionWay()).toBeChecked();
      expect(companyKeyWay()).toBeChecked();

      // Back where it started: nothing to save, and a save sends no runtime.
      await waitFor(() =>
        expect(onDirtyChange).toHaveBeenLastCalledWith(false),
      );
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody()).not.toHaveProperty("runtime");
      expect(savedBody()).not.toHaveProperty("llmApiKeyId");
    });

    it("does not send an unchanged lock", async () => {
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ lock: "key" })}
          sections={["configuration", "runtime"]}
        />,
      );
      await user.type(
        await screen.findByDisplayValue("Existing Agent"),
        " renamed",
      );
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toBeDefined();
      expect(savedBody().runtime).not.toHaveProperty("accountLock");
    });

    it("keeps a locked Claude agent's connection and model read-only for someone who may not use its runtime", async () => {
      // Someone who may use the runtime locked this agent to its company
      // key. The reader may not use it, so the lock holds for them.
      runtimePermissions.current = {
        canChange: false,
        canConfigure: false,
        readOnlyBy: null,
      };
      const anthropicKey = {
        id: "anthropic-key",
        name: "Company Anthropic",
        provider: "anthropic",
        scope: "org",
        bestModelId: "claude-model",
      };
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [anthropicKey],
      });
      render(
        <AgentForm
          agentType="agent"
          agent={{
            ...lockedAgent({ llmApiKeyId: "anthropic-key" }),
            modelId: "claude-model",
            runtime: {
              ...lockRuntime(["archestra-claude-code"], "key"),
              inferenceProtocol: "anthropic" as const,
              claudeCode: { authentication: "provider" as const },
            },
          }}
          sections={["configuration"]}
        />,
      );
      // The runtime's rule names no account, so `use` on it is what changing
      // the lock takes.
      expect(
        await screen.findByText(/This agent's account is locked/),
      ).toHaveTextContent(
        "Only people who can use the agent's runtime can change it.",
      );
      expect(
        screen.getByRole("button", { name: "Pick API key" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Pick manual model" }),
      ).toBeDisabled();
    });

    it("leaves a locked Claude agent's accounts to someone who may only use a runtime that stores a Claude account and names no kind", async () => {
      // The runtime's settings store each person's subscription, with no
      // rule. That restricts nobody: the agent's lock is theirs to change.
      runtimePermissions.current = {
        canChange: true,
        canConfigure: false,
        readOnlyBy: "Claude Code",
      };
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [
          {
            id: "anthropic-key",
            name: "Company Anthropic",
            provider: "anthropic",
            scope: "org",
            bestModelId: "claude-model",
          },
        ],
      });
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={{
            ...lockedAgent({ llmApiKeyId: "anthropic-key" }),
            modelId: "claude-model",
            runtime: {
              ...lockRuntime(["archestra-claude-code"], "key"),
              inferenceProtocol: "anthropic" as const,
              claudeCode: { authentication: "provider" as const },
            },
          }}
          sections={["configuration"]}
        />,
      );
      const claudeSubscriptionWay = await screen.findByRole("checkbox", {
        name: /Each person's Claude subscription/,
      });
      expect(claudeSubscriptionWay).not.toBeChecked();
      expect(claudeSubscriptionWay).not.toHaveAttribute("aria-readonly");
      expect(
        screen.queryByText(/This agent's account is locked/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/can change which accounts run it/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Pick API key" }),
      ).toBeEnabled();
      // The lock moves: both ways open is saved as no lock.
      await user.click(claudeSubscriptionWay);
      expect(claudeSubscriptionWay).toBeChecked();
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({ accountLock: null });
    });

    it("does not block Save for a lock this edit leaves as it is", async () => {
      // A subscription lock on an agent whose own account is a company key
      // does not fit, but the backend accepts a save that moves neither.
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ lock: "subscription" })}
          sections={["configuration"]}
        />,
      );
      await screen.findByText("Accounts that can run it");
      expect(
        screen.queryByText(/^To allow only personal subscriptions/),
      ).not.toBeInTheDocument();
      await user.type(
        await screen.findByDisplayValue("Existing Agent"),
        " renamed",
      );
      expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();

      // A runtime with no subscription of its own has no option to untick,
      // so giving it a company connection lifts the lock it could not keep.
      await user.click(screen.getByRole("button", { name: "Pick API key" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({ accountLock: null });
      expect(savedBody().llmApiKeyId).toBe("key-1");
    });

    it("does not block Save for an editor who cannot see the lock", async () => {
      runtimePermissions.current = {
        canChange: true,
        canConfigure: false,
        readOnlyBy: "Worker",
      };
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({ lock: "subscription" })}
          sections={["configuration"]}
        />,
      );
      await user.type(
        await screen.findByDisplayValue("Existing Agent"),
        " renamed",
      );
      expect(screen.getByRole("button", { name: /update/i })).toBeEnabled();
    });

    it("leaves an unlocked account editable for people who cannot configure the runtime", async () => {
      runtimePermissions.current = {
        canChange: true,
        canConfigure: false,
        readOnlyBy: "Worker",
      };
      render(
        <AgentForm
          agentType="agent"
          agent={lockedAgent({})}
          sections={["configuration"]}
        />,
      );
      expect(
        await screen.findByRole("button", { name: "Pick API key" }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/This agent's account is locked/),
      ).not.toBeInTheDocument();
    });

    it("lets someone who may only use the runtime change a saved agent's accounts where the runtime leaves them to the agent", async () => {
      runtimePermissions.current = {
        canChange: true,
        canConfigure: false,
        readOnlyBy: "Claude Code",
      };
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [
          {
            id: "anthropic-key",
            name: "Company Anthropic",
            provider: "anthropic",
            scope: "org",
            bestModelId: "claude-model",
          },
        ],
      });
      const user = userEvent.setup();
      render(
        <AgentForm
          agentType="agent"
          agent={{
            ...lockedAgent({ llmApiKeyId: "anthropic-key" }),
            modelId: "claude-model",
            runtime: {
              ...lockRuntime(["archestra-claude-code"]),
              inferenceProtocol: "anthropic" as const,
              claudeCode: { authentication: "provider" as const },
            },
          }}
          sections={["configuration"]}
        />,
      );
      const claudeSubscriptionWay = await screen.findByRole("checkbox", {
        name: /Each person's Claude subscription/,
      });
      expect(claudeSubscriptionWay).toBeChecked();
      expect(claudeSubscriptionWay).not.toHaveAttribute("aria-readonly");
      expect(
        screen.queryByText(/can change which accounts run it/),
      ).not.toBeInTheDocument();

      await user.click(claudeSubscriptionWay);
      expect(claudeSubscriptionWay).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
      expect(savedBody().runtime).toMatchObject({
        accountLock: "key",
        claudeCode: { authentication: "provider" },
      });
    });

    it("keeps a Claude agent's boxes reachable, and its connection disabled, for someone who may not use its runtime", async () => {
      runtimePermissions.current = {
        canChange: false,
        canConfigure: false,
        readOnlyBy: null,
      };
      useAvailableLlmProviderApiKeysMock.mockReturnValue({
        data: [
          {
            id: "anthropic-key",
            name: "Company Anthropic",
            provider: "anthropic",
            scope: "org",
            bestModelId: "claude-model",
          },
        ],
      });
      render(
        <AgentForm
          agentType="agent"
          agent={{
            ...lockedAgent({ llmApiKeyId: "anthropic-key" }),
            modelId: "claude-model",
            runtime: {
              ...lockRuntime(["archestra-claude-code"]),
              inferenceProtocol: "anthropic" as const,
              claudeCode: { authentication: "provider" as const },
            },
          }}
          sections={["configuration"]}
        />,
      );
      const claudeSubscriptionWay = await screen.findByRole("checkbox", {
        name: /Each person's Claude subscription/,
      });
      // Read-only, not disabled: a disabled box cannot be focused to be read.
      expect(claudeSubscriptionWay).toBeEnabled();
      expect(claudeSubscriptionWay).toHaveAttribute("aria-readonly", "true");
      expect(
        screen.getByRole("button", { name: "Pick API key" }),
      ).toBeDisabled();
      // The runtime's rule names no account, so `use` on it is what
      // changing them takes.
      expect(
        screen.getByText(
          "Only people who can use the agent's runtime can change which accounts run it.",
        ),
      ).toBeVisible();
    });

    describe("the account rule its runtime sets for every agent", () => {
      type RuntimeId = "opencode" | "codex" | "claude-code" | "grok";
      const template = (id: RuntimeId) =>
        getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
          (candidate) => candidate.id === id,
        );
      const LOCK_LINE = /^An admin locked this connection/;
      /** A model of the runtime's connection, as the rule lists it. */
      const ruleModel = {
        id: "rule-model",
        modelId: "gpt-5",
        displayName: "GPT-5",
        provider: "openai",
      };
      /**
       * The runtime's rule, with what the server fills in: the names, and
       * the connection's models where it fixes no model.
       */
      const fixed = (model: boolean) => ({
        llmApiKeyId: "runtime-key",
        keyName: "Runtime OpenAI",
        keyProvider: "openai",
        ...(model
          ? { modelId: "runtime-model", modelName: "Runtime GPT" }
          : { models: [ruleModel] }),
      });
      type Rule = NonNullable<typeof runtimePermissions.current.accounts>;
      /** May use the runtime, not configure it. */
      const useOnly = (name: string, accounts: Rule | null) => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: false,
          readOnlyBy: name,
          accounts,
        };
      };
      /** May configure the runtime: the rule holds for them as well. */
      const configurer = (accounts: Rule | null) => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: true,
          readOnlyBy: null,
          accounts,
        };
      };
      const renderNew = (id: RuntimeId) =>
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId={id}
            initialValues={template(id)?.initialValues}
          />,
        );
      const create = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(screen.getByLabelText(/Name/), "Their agent");
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        return createAgent.mock.calls[0][0];
      };
      const renameAndUpdate = async (
        user: ReturnType<typeof userEvent.setup>,
      ) => {
        await user.type(
          await screen.findByDisplayValue("Existing Agent"),
          " renamed",
        );
        await user.click(screen.getByRole("button", { name: /update/i }));
        await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
        return savedBody();
      };
      const row = () =>
        screen.getByRole("button", { name: /^Accounts that can run it/ });

      it("shows a fixed connection and model as two disabled fields with their note", async () => {
        useOnly("OpenCode", fixed(true));
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        renderNew("opencode");

        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        await waitFor(() =>
          expect(screen.getByTestId("selected-model-name")).toHaveTextContent(
            "Runtime GPT",
          ),
        );
        expect(
          screen.getByRole("button", { name: "Pick API key" }),
        ).toBeDisabled();
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeDisabled();
        expect(
          screen.getByText("An admin locked this connection and model."),
        ).toBeVisible();
        // The row's summary names them as the fields do.
        expect(row()).toHaveTextContent("Runtime OpenAI, Runtime GPT");
        expect(
          screen.getByText("Set by the OpenCode runtime").parentElement,
        ).toHaveTextContent(
          "limits, tiers, accounts, connection or model needs agentRuntime:configure on it.",
        );
        // Both are the runtime's: the agent stores neither.
        const body = await create(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("leaves the model of a fixed connection to each person unless the agent sets one, and saves that model alone", async () => {
        useOnly("OpenCode", fixed(false));
        // The connection is not one they can read: only its name is known,
        // and its models come with the rule.
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        renderNew("opencode");

        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(
          screen.getByRole("button", { name: "Pick API key" }),
        ).toBeDisabled();
        expect(
          screen.getByText("An admin locked this connection."),
        ).toBeInTheDocument();
        // The line speaks only of what is left to the agent: the model.
        expect(
          screen.getByText(
            "Each person picks their model on the agent's page, unless you set one here.",
          ),
        ).toBeInTheDocument();
        expect(row()).toHaveTextContent("Runtime OpenAI, each person's model");
        // The notice names the connection, and not the model, as the
        // runtime's to change.
        expect(
          screen.getByText("Set by the OpenCode runtime").parentElement,
        ).toHaveTextContent(
          "limits, tiers, accounts or connection needs agentRuntime:configure on it.",
        );

        // Nothing is asked for: the agent can be created as it is.
        await user.type(screen.getByLabelText(/Name/), "Their agent");
        expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
        expect(screen.getByTestId("offered-models")).toHaveTextContent("GPT-5");
        await user.click(
          screen.getByRole("button", { name: "Pick manual model" }),
        );
        expect(
          screen.getByText("Every run uses this model."),
        ).toBeInTheDocument();
        await waitFor(() =>
          expect(row()).toHaveTextContent("Runtime OpenAI, GPT-5"),
        );
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        // The connection is the runtime's: only the agent's model is sent.
        const body = createAgent.mock.calls[0][0];
        expect(body).toMatchObject({ modelId: "rule-model" });
        expect(body).not.toHaveProperty("llmApiKeyId");
      });

      it("creates an agent on a fixed connection with no model of its own, and clears a saved one", async () => {
        useOnly("OpenCode", fixed(false));
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        const created = renderNew("opencode");
        await screen.findByTestId("locked-connection");
        const body = await create(user);
        expect(body).toMatchObject({ modelId: null });
        expect(body).not.toHaveProperty("llmApiKeyId");
        created.unmount();

        render(
          <AgentForm
            agentType="agent"
            // Saved under the rule: one of the connection's models, alone.
            agent={{
              ...lockedAgent({
                command: ["archestra-opencode"],
                llmApiKeyId: null,
              }),
              modelId: "rule-model",
            }}
            sections={["configuration"]}
          />,
        );
        expect(
          await screen.findByText("Every run uses this model."),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Clear model" }));
        expect(
          screen.getByText(
            "Each person picks their model on the agent's page, unless you set one here.",
          ),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /update/i }));
        await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
        expect(savedBody()).toMatchObject({ modelId: null });
        expect(savedBody()).not.toHaveProperty("llmApiKeyId");
      });

      it("says when the fixed connection has no model the runtime can run, and asks for none", async () => {
        useOnly("OpenCode", { ...fixed(false), models: [] });
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        renderNew("opencode");

        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(
          screen.getByText(
            "The connection this runtime fixes has no model the runtime can run. Ask someone who can configure the runtime to choose another.",
          ),
        ).toBeInTheDocument();
        expect(screen.queryByText(LOCK_LINE)).not.toBeInTheDocument();
        expect(screen.queryByText(/picks their model/)).toBeNull();
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeDisabled();
        const body = await create(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body.modelId ?? null).toBeNull();
      });

      it("leaves a saved agent as it is when its own model is none of the fixed connection's, and asks for none", async () => {
        useOnly("OpenCode", fixed(false));
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            // Its own model is of its own connection, not the runtime's.
            agent={lockedAgent({ command: ["archestra-opencode"] })}
            sections={["configuration"]}
          />,
        );
        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
        expect(
          screen.getByText(
            "Each person picks their model on the agent's page, unless you set one here.",
          ),
        ).toBeInTheDocument();
        const body = await renameAndUpdate(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      describe("under a kind the rule names: the one card of that kind", () => {
        const accounts = () =>
          screen.getByRole("group", { name: "Accounts that can run it" });
        const TITLES = {
          "claude-code": "Each person's Claude subscription",
          codex: "Each person's ChatGPT subscription",
          grok: "Each person's SuperGrok subscription",
        };
        const COMPANY = "A company API key";
        /**
         * One card, always on, as a runtime with one kind of account shows
         * it: no box to tick, no card for the other kind, and nothing said
         * about a choice or about who may change it.
         */
        const expectOneCard = (
          id: keyof typeof TITLES,
          kind: "subscription" | "key",
        ) => {
          const [shown, hidden] =
            kind === "key" ? [COMPANY, TITLES[id]] : [TITLES[id], COMPANY];
          expect(within(accounts()).getByText(shown)).toBeInTheDocument();
          expect(within(accounts()).queryByText(hidden)).toBeNull();
          expect(within(accounts()).queryByRole("checkbox")).toBeNull();
          expect(screen.queryByText(/^Locked to /)).toBeNull();
          expect(
            screen.queryByText(
              /sets which accounts run it|can change which accounts run it|account is locked/,
            ),
          ).toBeNull();
          // The company card holds its two fields; the subscription card
          // holds none.
          expect(
            screen.queryAllByRole("button", { name: "Pick API key" }),
          ).toHaveLength(kind === "key" ? 1 : 0);
        };
        const CASES = [
          ["claude-code", "subscription"],
          ["claude-code", "key"],
          ["codex", "subscription"],
          ["codex", "key"],
          ["grok", "subscription"],
          ["grok", "key"],
        ] as const;

        it.each(
          CASES,
        )("shows a new %s agent only the %s card, with no box, and names no lock of its own", async (id, kind) => {
          configurer({ kind });
          if (id === "grok") withGrokKeys();
          const user = userEvent.setup();
          renderNew(id);

          await waitFor(() => expectOneCard(id, kind));
          // Its fields follow the same rule as anywhere: both optional. No
          // company connection here runs Claude, and then the fields say
          // only that.
          const nothingSet = screen.queryByText(
            "Optional. Set a connection and model to fix them for every run on the company account. Leave them empty and each person picks their own on the agent's page.",
          );
          if (kind === "key" && id !== "claude-code") {
            expect(nothingSet).toBeInTheDocument();
          } else {
            expect(nothingSet).toBeNull();
          }
          const body = await create(user);
          // The rule is the runtime's: the agent names no lock, and stores
          // nothing of the kind that is not shown.
          expect(body.runtime).not.toHaveProperty("accountLock");
          if (kind === "key") {
            expect(body).toMatchObject({ llmApiKeyId: null, modelId: null });
          }
        });

        it.each(
          CASES,
        )("shows a saved %s agent that stores the other kind only the %s card, and saves no account change", async (id, kind) => {
          useOnly("Its runtime", { kind });
          if (id === "grok") withGrokKeys();
          const other = kind === "key" ? "subscription" : "key";
          const saved =
            id === "grok"
              ? grokAgent({
                  lock: other,
                  llmApiKeyId: other === "key" ? "xai-key" : "supergrok-key",
                })
              : id === "codex"
                ? lockedAgent({
                    command: codex,
                    lock: other,
                    llmApiKeyId: other === "key" ? "openai-key" : "chatgpt-key",
                  })
                : {
                    ...lockedAgent({
                      llmApiKeyId: other === "key" ? "openai-key" : null,
                    }),
                    modelId: other === "key" ? "openai-model" : null,
                    runtime: {
                      ...lockRuntime(["archestra-claude-code"], other),
                      inferenceProtocol: "anthropic" as const,
                      claudeCode: {
                        authentication:
                          other === "key"
                            ? ("provider" as const)
                            : ("subscription" as const),
                      },
                    },
                  };
          const user = userEvent.setup();
          render(
            <AgentForm
              agentType="agent"
              agent={saved}
              sections={["configuration"]}
            />,
          );

          await waitFor(() => expectOneCard(id, kind));
          const body = await renameAndUpdate(user);
          expect(body).toMatchObject({ name: "Existing Agent renamed" });
          expect(body).not.toHaveProperty("llmApiKeyId");
          expect(body).not.toHaveProperty("modelId");
          expect(body).not.toHaveProperty("runtime");
        });

        it("leaves the notice as the place that says the runtime decides, for someone who may only use it", async () => {
          useOnly("Codex", { kind: "subscription" });
          renderNew("codex");

          await waitFor(() => expectOneCard("codex", "subscription"));
          expect(
            screen.getByText("Set by the Codex runtime").parentElement,
          ).toHaveTextContent(
            "Changing its launch command, protocol, follow-up delivery, limits, tiers or accounts needs agentRuntime:configure on it. Environment, credentials and ports stay this agent's own.",
          );
        });

        it.each([
          "subscription",
          "key",
        ] as const)("shows someone who may configure the runtime no notice under the %s kind: nothing is set over their head", async (kind) => {
          configurer({ kind });
          renderNew("codex");

          await waitFor(() => expectOneCard("codex", kind));
          expect(screen.queryByText(/^Set by the /)).toBeNull();
          expect(screen.queryByText(/agentRuntime:configure/)).toBeNull();
        });

        it.each([
          "subscription",
          "key",
        ] as const)("names the accounts as the runtime's on a saved agent's runtime settings, under the %s kind", async (kind) => {
          useOnly("Team Codex", { kind });
          const other = kind === "key" ? "subscription" : "key";
          render(
            <AgentForm
              agentType="agent"
              // It stores the other kind, from before the rule.
              agent={lockedAgent({
                command: codex,
                lock: other,
                llmApiKeyId: other === "key" ? "openai-key" : "chatgpt-key",
              })}
              sections={["configuration", "runtime"]}
            />,
          );

          await waitFor(() => expectOneCard("codex", kind));
          // The accounts are the runtime's to change, and not among what
          // stays the agent's own.
          expect(
            screen.getByText("Set by the Team Codex runtime").parentElement,
          ).toHaveTextContent(
            "Changing its launch command, protocol, follow-up delivery, limits, tiers or accounts needs agentRuntime:configure on it. Environment, credentials and ports stay this agent's own.",
          );
        });

        it("shows someone who may configure the runtime no notice on a saved agent either", async () => {
          configurer({ kind: "key" });
          render(
            <AgentForm
              agentType="agent"
              agent={lockedAgent({
                command: codex,
                lock: "subscription",
                llmApiKeyId: "chatgpt-key",
              })}
              sections={["configuration", "runtime"]}
            />,
          );

          await waitFor(() => expectOneCard("codex", "key"));
          expect(screen.queryByText(/^Set by the /)).toBeNull();
        });

        it("names the connection the rule fixes beside the accounts, for someone who may only use the runtime", async () => {
          useOnly("Team Codex", { kind: "key", ...fixed(true) });
          useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
          renderNew("codex");

          await waitFor(() => expectOneCard("codex", "key"));
          expect(
            screen.getByText("Set by the Team Codex runtime").parentElement,
          ).toHaveTextContent(
            "Changing its launch command, protocol, follow-up delivery, limits, tiers, accounts, connection or model needs agentRuntime:configure on it. Environment, credentials and ports stay this agent's own.",
          );
        });

        it("shows the one company card on the connection and model the rule fixes, disabled, with the note", async () => {
          configurer({ kind: "key", ...fixed(true) });
          useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
          const user = userEvent.setup();
          renderNew("codex");

          await waitFor(() => expectOneCard("codex", "key"));
          expect(screen.getByTestId("locked-connection")).toHaveTextContent(
            "Runtime OpenAI",
          );
          expect(screen.getByTestId("selected-model-name")).toHaveTextContent(
            "Runtime GPT",
          );
          expect(
            screen.getByRole("button", { name: "Pick manual model" }),
          ).toBeDisabled();
          expect(
            screen.getByText("An admin locked this connection and model."),
          ).toBeInTheDocument();
          // Both are fixed above: nothing is left to say of this level.
          expect(screen.queryByText(/^Every run uses/)).toBeNull();
          const body = await create(user);
          expect(body).not.toHaveProperty("llmApiKeyId");
          expect(body).not.toHaveProperty("modelId");
          expect(body.runtime).not.toHaveProperty("accountLock");
        });

        it("keeps both cards with their boxes where the rule names no kind", async () => {
          configurer(null);
          renderNew("codex");

          expect(
            await screen.findByRole("checkbox", { name: /A company API key/ }),
          ).toBeInTheDocument();
          expect(subscriptionWay()).toBeInTheDocument();
          expect(within(accounts()).getAllByRole("checkbox")).toHaveLength(2);
        });
      });

      it("leaves both fields to someone who may only use a runtime that fixes neither", async () => {
        useOnly("OpenCode", null);
        renderNew("opencode");

        expect(
          await screen.findByRole("button", { name: "Pick API key" }),
        ).toBeEnabled();
        expect(screen.queryByTestId("locked-connection")).toBeNull();
        expect(screen.queryByText(LOCK_LINE)).not.toBeInTheDocument();
        expect(
          screen.getByText("Set by the OpenCode runtime").parentElement,
        ).toHaveTextContent(
          "limits, tiers or accounts needs agentRuntime:configure on it.",
        );
      });

      it("puts a Claude agent's company card on the connection its runtime fixes, where the kind is left to the agent", async () => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: false,
          readOnlyBy: "Claude Code",
          accounts: { ...fixed(true), keyProvider: "anthropic" },
        };
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        renderNew("claude-code");
        const claudeSubscriptionWay = () =>
          screen.getByRole("checkbox", {
            name: /Each person's Claude subscription/,
          });

        // The cards are theirs to tick; the connection under the company
        // card is not theirs to change.
        await waitFor(() => expect(companyKeyWay()).toBeChecked());
        expect(companyKeyWay()).not.toHaveAttribute("aria-readonly");
        expect(screen.getByTestId("locked-connection")).toHaveTextContent(
          "Runtime OpenAI",
        );
        expect(
          screen.getByText("An admin locked this connection and model."),
        ).toBeVisible();
        // Subscriptions alone hide it; the company card brings it back.
        await user.click(claudeSubscriptionWay());
        await user.click(companyKeyWay());
        expect(screen.queryByTestId("locked-connection")).toBeNull();
        await user.click(companyKeyWay());
        expect(await screen.findByTestId("locked-connection")).toBeVisible();
        const body = await create(user);
        expect(body).toMatchObject({ runtime: { accountLock: null } });
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("holds a fixed connection and model for someone who may configure the runtime too", async () => {
        configurer(fixed(true));
        // Their own default connection, which the runtime's stands before.
        useAvailableLlmProviderApiKeysMock.mockReturnValue({
          data: [
            { ...companyKey, id: "my-default", isPrimary: true },
            { ...companyKey, id: "key-1" },
          ],
        });
        const user = userEvent.setup();
        renderNew("opencode");

        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(screen.getByTestId("selected-model-name")).toHaveTextContent(
          "Runtime GPT",
        );
        expect(
          screen.getByRole("button", { name: "Pick API key" }),
        ).toBeDisabled();
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeDisabled();
        expect(
          screen.getByText("An admin locked this connection and model."),
        ).toBeVisible();
        expect(row()).toHaveTextContent("Runtime OpenAI, Runtime GPT");
        const body = await create(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("shows the rule's connection on a saved agent that stores another, for someone who may only use the runtime", async () => {
        useOnly("OpenCode", fixed(true));
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            agent={lockedAgent({ command: ["archestra-opencode"] })}
            sections={["configuration"]}
          />,
        );
        // The runtime's connection and model show, not the agent's own.
        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(screen.getByTestId("selected-model-name")).toHaveTextContent(
          "Runtime GPT",
        );
        // Its own stay stored as they are.
        const body = await renameAndUpdate(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("shows a saved agent's model on the fixed connection, where the agent stores that model and no connection", async () => {
        useOnly("OpenCode", fixed(false));
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            // Saved under the rule: one of the connection's models, alone.
            agent={{
              ...lockedAgent({
                command: ["archestra-opencode"],
                llmApiKeyId: null,
              }),
              modelId: "rule-model",
            }}
            sections={["configuration"]}
          />,
        );
        expect(
          await screen.findByTestId("locked-connection"),
        ).toHaveTextContent("Runtime OpenAI");
        expect(screen.getByTestId("selected-model-name")).toHaveTextContent(
          "GPT-5",
        );
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeEnabled();
        // Complete as it is: an unrelated edit saves, and moves no account.
        const body = await renameAndUpdate(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("says when the connection the runtime fixes no longer works, and does not offer the agent's own instead", async () => {
        configurer({ llmApiKeyId: "gone-key", keyMissing: true });
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            agent={lockedAgent({ command: ["archestra-opencode"] })}
            sections={["configuration"]}
          />,
        );
        expect(
          await screen.findByText(
            "The connection this runtime fixes no longer works. Ask someone who can configure the runtime to choose another.",
          ),
        ).toBeVisible();
        expect(screen.queryByText(LOCK_LINE)).not.toBeInTheDocument();
        // The fields stay the runtime's, and name no connection.
        expect(screen.getByTestId("locked-connection")).toHaveTextContent("");
        expect(
          screen.getByRole("button", { name: "Pick API key" }),
        ).toBeDisabled();
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeDisabled();
        expect(screen.getByTestId("selected-model")).toHaveTextContent("");
        // Nothing here puts it right, so other edits still save.
        const body = await renameAndUpdate(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });

      it("says when the model the runtime fixes no longer works", async () => {
        useOnly("OpenCode", {
          llmApiKeyId: "runtime-key",
          keyName: "Runtime OpenAI",
          keyProvider: "openai",
          modelId: "gone-model",
          modelMissing: true,
        });
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        renderNew("opencode");

        expect(
          await screen.findByText(
            "The model this runtime fixes no longer works. Ask someone who can configure the runtime to choose another.",
          ),
        ).toBeVisible();
        expect(screen.getByTestId("locked-connection")).toHaveTextContent(
          "Runtime OpenAI",
        );
        expect(
          screen.getByRole("button", { name: "Pick manual model" }),
        ).toBeDisabled();
        expect(screen.queryByText(LOCK_LINE)).not.toBeInTheDocument();
        // The row says so too, where the form is collapsed.
        expect(
          screen.getByRole("img", {
            name: "The model this runtime fixes no longer works",
          }),
        ).toBeInTheDocument();
      });

      it("names what the runtime fixes in the row's summary for someone who may configure it", async () => {
        configurer(fixed(true));
        // They cannot read the runtime's connection either.
        useAvailableLlmProviderApiKeysMock.mockReturnValue({ data: [] });
        renderNew("opencode");

        await waitFor(() =>
          expect(row()).toHaveTextContent("Runtime OpenAI, Runtime GPT"),
        );
      });

      it("sends no connection or model of its own on update, whatever the form took up before the rule answered", async () => {
        useOnly("OpenCode", null);
        runtimePermissions.current.accounts = undefined;
        useAvailableLlmProviderApiKeysMock.mockReturnValue({
          data: [companyKey, { ...companyKey, id: "key-1" }],
        });
        const user = userEvent.setup();
        const saved = lockedAgent({ command: ["archestra-opencode"] });
        const { rerender } = render(
          <AgentForm
            agentType="agent"
            agent={saved}
            sections={["configuration"]}
          />,
        );
        // A change of connection made while the fields were still theirs.
        await user.click(
          await screen.findByRole("button", { name: "Pick API key" }),
        );
        runtimePermissions.current = {
          ...runtimePermissions.current,
          accounts: fixed(true),
        };
        rerender(
          <AgentForm
            agentType="agent"
            agent={saved}
            sections={["configuration"]}
          />,
        );
        await screen.findByTestId("locked-connection");
        const body = await renameAndUpdate(user);
        expect(body).not.toHaveProperty("llmApiKeyId");
        expect(body).not.toHaveProperty("modelId");
      });
    });

    describe("the company card's connection and model, each optional", () => {
      const template = (id: "opencode" | "codex" | "claude-code") =>
        getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
          (candidate) => candidate.id === id,
        );
      const renderNew = (id: "opencode" | "codex" | "claude-code") =>
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId={id}
            initialValues={template(id)?.initialValues}
          />,
        );
      const create = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(screen.getByLabelText(/Name/), "Their agent");
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        return createAgent.mock.calls[0][0];
      };
      const row = () =>
        screen.getByRole("button", { name: /^Accounts that can run it/ });
      const NOTHING_SET =
        "Optional. Set a connection and model to fix them for every run on the company account. Leave them empty and each person picks their own on the agent's page.";
      const CONNECTION_SET =
        "Every run uses this connection. Each person picks their model on the agent's page, unless you set one here.";
      const BOTH_SET = "Every run uses this connection and model.";
      /** The creator's own default connection, which the picker also offers. */
      const ownDefault = { ...companyKey, id: "key-1", isPrimary: true };

      beforeEach(() => {
        useAvailableLlmProviderApiKeysMock.mockReturnValue({
          data: [ownDefault, companyKey, chatgptKey],
        });
      });

      it("starts a new agent's fields empty, whatever default connection its creator has, and asks for nothing", async () => {
        const user = userEvent.setup();
        renderNew("opencode");

        expect(await screen.findByText(NOTHING_SET)).toBeInTheDocument();
        expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
        // The model waits for a connection.
        expect(
          screen.queryByRole("button", { name: "Pick manual model" }),
        ).toBeNull();
        expect(row()).toHaveTextContent("Each person's connection and model");
        expect(
          screen.queryByRole("img", { name: /Select a/ }),
        ).not.toBeInTheDocument();
        const body = await create(user);
        expect(body).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: { command: ["archestra-opencode"] },
        });
        // One account leaves nothing to lock.
        expect(body.runtime).not.toHaveProperty("accountLock");
      });

      it("fixes the connection alone, then its model, and clears each again", async () => {
        const user = userEvent.setup();
        renderNew("opencode");

        await user.click(
          await screen.findByRole("button", { name: "Pick API key" }),
        );
        // A connection brings no model with it.
        expect(screen.getByText(CONNECTION_SET)).toBeInTheDocument();
        expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
        expect(row()).toHaveTextContent("Company OpenAI, each person's model");

        await user.click(
          screen.getByRole("button", { name: "Pick manual model" }),
        );
        expect(screen.getByText(BOTH_SET)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Clear model" }));
        expect(screen.getByText(CONNECTION_SET)).toBeInTheDocument();

        // The connection takes its model away with it.
        await user.click(
          screen.getByRole("button", { name: "Pick manual model" }),
        );
        await user.click(
          screen.getByRole("button", { name: "Clear connection" }),
        );
        expect(screen.getByText(NOTHING_SET)).toBeInTheDocument();
        expect(screen.getByTestId("selected-model")).toBeEmptyDOMElement();
      });

      it.each([
        ["nothing", [], { llmApiKeyId: null, modelId: null }],
        [
          "a connection",
          ["Pick API key"],
          { llmApiKeyId: "key-1", modelId: null },
        ],
        [
          "a connection and its model",
          ["Pick API key", "Pick manual model"],
          { llmApiKeyId: "key-1", modelId: "manual-model" },
        ],
      ] as const)("creates an agent with %s set on its company card", async (_state, clicks, payload) => {
        const user = userEvent.setup();
        renderNew("opencode");
        await screen.findByRole("button", { name: "Pick API key" });
        for (const name of clicks) {
          await user.click(screen.getByRole("button", { name }));
        }
        expect(await create(user)).toMatchObject(payload);
      });

      it.each([
        [
          "nothing",
          "Clear connection",
          { llmApiKeyId: null, modelId: null },
          NOTHING_SET,
        ],
        [
          "its connection alone",
          "Clear model",
          { llmApiKeyId: "openai-key", modelId: null },
          CONNECTION_SET,
        ],
        [
          "another connection, without the old one's model",
          "Pick API key",
          { llmApiKeyId: "key-1", modelId: null },
          CONNECTION_SET,
        ],
      ] as const)("saves a saved agent's company card left with %s", async (_state, click, payload, line) => {
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            // It stores a connection and a model.
            agent={lockedAgent({ command: ["archestra-opencode"] })}
            sections={["configuration"]}
          />,
        );
        expect(await screen.findByText(BOTH_SET)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: click }));
        expect(screen.getByText(line)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /update/i }));
        await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
        expect(savedBody()).toMatchObject(payload);
      });

      it("starts a new Codex agent on its creator's ChatGPT subscription, and needs no connection for the company API key", async () => {
        const user = userEvent.setup();
        renderNew("codex");

        // Two kinds of account and no rule: the creator has ChatGPT, so the
        // agent starts on subscriptions, like Claude Code, and can be
        // created at once.
        await waitFor(() => expect(subscriptionWay()).toBeChecked());
        expect(companyKeyWay()).not.toBeChecked();
        expect(screen.queryByText("Select at least one option.")).toBeNull();

        await user.click(companyKeyWay());
        await user.click(subscriptionWay());
        expect(screen.getByText(NOTHING_SET)).toBeInTheDocument();
        // The company key runs it, so their own ChatGPT is not asked for,
        // and is not kept as the company option's connection.
        expect(
          screen.queryByText("ChatGPT Subscription required"),
        ).not.toBeInTheDocument();
        expect(await create(user)).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: { accountLock: "key" },
        });
      });

      it("takes the creator's ChatGPT subscription again once a new Codex agent is left on subscriptions alone", async () => {
        const user = userEvent.setup();
        renderNew("codex");
        await waitFor(() => expect(subscriptionWay()).toBeChecked());

        // The company card alone, then both, then the subscription alone.
        await user.click(companyKeyWay());
        await user.click(subscriptionWay());
        await user.click(subscriptionWay());
        await user.click(companyKeyWay());
        expect(subscriptionWay()).toBeChecked();
        expect(companyKeyWay()).not.toBeChecked();
        expect(await create(user)).toMatchObject({
          llmApiKeyId: "chatgpt-key",
          runtime: { accountLock: "subscription" },
        });
      });

      it("opens the company API key beside subscriptions on Codex with nothing set for it", async () => {
        const user = userEvent.setup();
        renderNew("codex");
        await waitFor(() => expect(subscriptionWay()).toBeChecked());
        await user.click(companyKeyWay());

        expect(subscriptionWay()).toBeChecked();
        expect(companyKeyWay()).toBeChecked();
        expect(screen.getByText(NOTHING_SET)).toBeInTheDocument();
        expect(await create(user)).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: { accountLock: null },
        });
      });

      it("starts a new Claude agent on the company API key its runtime stores, with no connection", async () => {
        const user = userEvent.setup();
        const claude = template("claude-code")?.initialValues;
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId="claude-code"
            initialValues={
              claude && {
                ...claude,
                runtime: claude.runtime && {
                  ...claude.runtime,
                  claudeCode: {
                    ...claude.runtime.claudeCode,
                    authentication: "provider",
                  },
                },
              }
            }
          />,
        );

        await waitFor(() => expect(companyKeyWay()).toBeChecked());
        expect(
          screen.getByRole("checkbox", {
            name: /Each person's Claude subscription/,
          }),
        ).not.toBeChecked();
        // No company connection here runs Claude: the fields say only that.
        expect(screen.queryByText(NOTHING_SET)).toBeNull();
        expect(
          screen.queryByRole("img", { name: /Select a provider/ }),
        ).not.toBeInTheDocument();
        expect(await create(user)).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: {
            accountLock: "key",
            claudeCode: { authentication: "provider" },
          },
        });
      });

      it("opens the company API key beside subscriptions on a Claude agent with nothing set for it", async () => {
        const user = userEvent.setup();
        renderNew("claude-code");
        const claudeSubscriptionWay = () =>
          screen.getByRole("checkbox", {
            name: /Each person's Claude subscription/,
          });
        await waitFor(() => expect(claudeSubscriptionWay()).toBeChecked());

        await user.click(companyKeyWay());
        expect(claudeSubscriptionWay()).toBeChecked();
        expect(companyKeyWay()).toBeChecked();
        // No company connection here runs Claude: the fields say only that.
        expect(screen.queryByText(NOTHING_SET)).toBeNull();
        // Nothing is asked for the company card.
        expect(screen.queryByText(/^Choose a connection and model/)).toBeNull();
        expect(await create(user)).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: { accountLock: null },
        });
      });

      describe("an organization default the runtime cannot run", () => {
        const organizationDefault = (
          provider: "anthropic" | "openai",
          displayName: string,
        ) =>
          useOrganizationDefaultModelMock.mockReturnValue({
            autoRouters: [],
            autoRoutedTiers: null,
            defaultAutoRouterId: null,
            label: displayName,
            model: {
              dbId: "default-model",
              id: displayName.toLowerCase().replaceAll(" ", "-"),
              displayName,
              provider,
              capabilities: { supportedEndpoints: null },
              isFree: false,
            },
          } as never);
        const NOTE =
          "The organization's default model, Claude Sonnet 4.5, cannot run on this runtime. Each person must pick a connection, unless you set one here.";
        // What the API answers such a save with, as the query layer hands
        // it on once it has shown it.
        const REFUSAL =
          "The maintained Codex runtime requires an OpenAI model, but the Agent's selected model uses Anthropic.";

        it("says so under the empty fields without holding Create back, and leaves the API's refusal to the one message already shown", async () => {
          organizationDefault("anthropic", "Claude Sonnet 4.5");
          createAgent.mockRejectedValue(new ReportedApiError(REFUSAL));
          const onCreated = vi.fn();
          const user = userEvent.setup();
          render(
            <AgentForm
              agentType="agent"
              sections={["configuration"]}
              initialRuntimeId="codex"
              initialValues={template("codex")?.initialValues}
              onCreated={onCreated}
            />,
          );
          await waitFor(() => expect(subscriptionWay()).toBeChecked());
          // The fields are not shown yet: nothing is said about them.
          expect(screen.queryByText(NOTE)).toBeNull();

          // Beside each person's own subscription their runs need no
          // connection: nothing is said yet.
          await user.click(companyKeyWay());
          expect(screen.getByText(NOTHING_SET)).toBeInTheDocument();
          expect(screen.queryByText(NOTE)).toBeNull();
          // The company API key alone: each person needs a connection.
          await user.click(subscriptionWay());
          expect(screen.getByText(NOTE)).toBeInTheDocument();
          // What the API resolves for each person is the API's to say: the
          // form holds no save back for it.
          await user.type(screen.getByLabelText(/Name/), "Their agent");
          await waitFor(() =>
            expect(
              screen.getByRole("button", { name: "Create" }),
            ).toBeEnabled(),
          );
          vi.mocked(toast.error).mockClear();
          vi.mocked(toast.success).mockClear();
          await user.click(screen.getByRole("button", { name: "Create" }));
          await waitFor(() => expect(createAgent).toHaveBeenCalled());
          expect(createAgent.mock.calls[0][0]).toMatchObject({
            llmApiKeyId: null,
            modelId: null,
          });

          // The refusal was shown once, by the write itself: the form adds
          // no second message, claims no save, and keeps what was entered.
          await waitFor(() =>
            expect(
              screen.getByRole("button", { name: "Create" }),
            ).toBeEnabled(),
          );
          expect(toast.error).not.toHaveBeenCalled();
          expect(toast.success).not.toHaveBeenCalled();
          expect(onCreated).not.toHaveBeenCalled();
          expect(screen.getByLabelText(/Name/)).toHaveValue("CodexTheir agent");
          // The reason stays beside the fields that put it right.
          expect(screen.getByText(NOTE)).toBeInTheDocument();
          await user.click(
            screen.getByRole("button", { name: "Pick API key" }),
          );
          expect(screen.queryByText(NOTE)).toBeNull();
        });

        it("says nothing where the organization default runs on the runtime", async () => {
          organizationDefault("openai", "GPT-5");
          const user = userEvent.setup();
          renderNew("codex");
          await waitFor(() => expect(subscriptionWay()).toBeChecked());

          await user.click(companyKeyWay());
          await user.click(subscriptionWay());
          expect(screen.getByText(NOTHING_SET)).toBeInTheDocument();
          expect(screen.queryByText(/cannot run on this runtime/)).toBeNull();
        });

        it("says nothing while a Claude agent's own account is each person's subscription", async () => {
          // Both ways open and nothing set for the company API key: the
          // agent's own account is the subscription, which the API accepts.
          organizationDefault("openai", "GPT-5");
          const user = userEvent.setup();
          renderNew("claude-code");
          await waitFor(() =>
            expect(
              screen.getByRole("checkbox", {
                name: /Each person's Claude subscription/,
              }),
            ).toBeChecked(),
          );

          await user.click(companyKeyWay());
          // No company connection here runs Claude: the fields say only that.
          expect(screen.queryByText(NOTHING_SET)).toBeNull();
          expect(screen.queryByText(/cannot run on this runtime/)).toBeNull();
        });
      });
    });

    describe("GitHub Copilot CLI", () => {
      const copilot = getAgentCatalogTemplates(TEST_CATALOG_IMAGES).find(
        (candidate) => candidate.id === "copilot",
      );
      const plan = (id: string, organization: string) => ({
        id,
        name: "GitHub Copilot",
        provider: "github-copilot",
        scope: "org",
        bestModelId: `${id}-model`,
        isGithubAppKey: true,
        githubOrganizationName: organization,
      });
      const withPlans = (...plans: ReturnType<typeof plan>[]) => {
        useAvailableLlmProviderApiKeysMock.mockReturnValue({
          // Someone's own Copilot sign-in is not a company account.
          data: [
            ...plans,
            {
              id: "my-copilot",
              name: "GitHub Copilot",
              provider: "github-copilot",
              scope: "personal",
              bestModelId: "plan-a-model",
            },
          ],
        });
        useLlmModelsByProviderMock.mockReturnValue({
          modelsByProvider: {
            "github-copilot": plans.map(({ bestModelId }) => ({
              dbId: bestModelId,
              id: "gpt-4o",
              displayName: "GPT-4o",
              provider: "github-copilot",
              isFree: false,
            })),
          },
        });
      };
      const copilotWay = () =>
        screen.getByRole("checkbox", {
          name: /Each person's GitHub Copilot subscription/,
        });
      const planWay = (organization: string) =>
        screen.getByRole("checkbox", {
          name: new RegExp(`^Enterprise plan: GitHub Copilot ${organization}`),
        });
      const cardOf = (checkbox: HTMLElement) =>
        checkbox.closest("label")?.parentElement as HTMLElement;
      const accounts = () =>
        screen.getByRole("group", { name: "Accounts that can run it" });

      const renderNewCopilot = () =>
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId="copilot"
            initialValues={copilot?.initialValues}
          />,
        );
      /**
       * A new Copilot agent starts on each person's own Copilot, like Claude
       * Code on Claude; unticking it leaves nothing ticked.
       */
      const untickCopilot = async (
        user: ReturnType<typeof userEvent.setup>,
      ) => {
        await waitFor(() => expect(copilotWay()).toBeChecked());
        await user.click(copilotWay());
        expect(
          await screen.findByText("Select at least one option."),
        ).toBeInTheDocument();
      };
      const createCopilot = async (
        user: ReturnType<typeof userEvent.setup>,
      ) => {
        await user.type(screen.getByLabelText(/Name/), "Copilot agent");
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
        );
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        return createAgent.mock.calls[0][0];
      };

      it("leaves the plan to each person while every plan is ticked, with a model to set for each, and fixes the one that is ticked alone, with its model", async () => {
        withPlans(plan("plan-a", "Example Org"), plan("plan-b", "Second Org"));
        const user = userEvent.setup();
        renderNewCopilot();
        await untickCopilot(user);
        // One plan ticked alone is fixed for every run.
        await user.click(planWay("Example Org"));
        expect(planWay("Example Org")).toBeChecked();
        expect(planWay("Second Org")).not.toBeChecked();
        expect(copilotWay()).not.toBeChecked();
        expect(
          within(cardOf(planWay("Example Org"))).getByText(
            "Each person picks their model on the agent's page, unless you set one here.",
          ),
        ).toBeInTheDocument();
        // Ticking the other opens the company's way on every plan: none is
        // fixed, and each card holds the model set for its plan.
        await user.click(planWay("Second Org"));
        expect(planWay("Example Org")).toBeChecked();
        expect(planWay("Second Org")).toBeChecked();
        const modelLeftOpen =
          "Each person who picks this plan picks their model.";
        for (const organization of ["Example Org", "Second Org"]) {
          expect(
            within(cardOf(planWay(organization))).getByText(modelLeftOpen),
          ).toBeInTheDocument();
        }
        await user.click(
          within(cardOf(planWay("Second Org"))).getByRole("button", {
            name: "Pick manual model",
          }),
        );
        expect(
          within(cardOf(planWay("Second Org"))).getByText(
            "Every run on this plan uses this model.",
          ),
        ).toBeInTheDocument();
        expect(
          within(cardOf(planWay("Example Org"))).getByText(modelLeftOpen),
        ).toBeInTheDocument();
        await user.click(copilotWay());
        const open = await createCopilot(user);
        expect(open).toMatchObject({
          llmApiKeyId: null,
          modelId: null,
          runtime: {
            accountLock: null,
            connectionModels: { "plan-b": "manual-model" },
          },
        });
      });

      it("keeps a plan's model with it when the other plan is ticked and unticked again", async () => {
        withPlans(plan("plan-a", "Example Org"), plan("plan-b", "Second Org"));
        const user = userEvent.setup();
        renderNewCopilot();
        await untickCopilot(user);

        // Fixed with its model, then every plan opened: the model is now
        // the one set for that plan.
        await user.click(planWay("Second Org"));
        await user.click(
          within(cardOf(planWay("Second Org"))).getByRole("button", {
            name: "Pick manual model",
          }),
        );
        await user.click(planWay("Example Org"));
        expect(
          within(cardOf(planWay("Second Org"))).getByText(
            "Every run on this plan uses this model.",
          ),
        ).toBeInTheDocument();

        // Fixed again: the model is the agent's own, and none is set per
        // plan.
        await user.click(planWay("Example Org"));
        expect(planWay("Example Org")).not.toBeChecked();
        expect(
          within(cardOf(planWay("Second Org"))).getByText(
            "Every run uses this model.",
          ),
        ).toBeInTheDocument();
        const fixed = await createCopilot(user);
        expect(fixed).toMatchObject({
          llmApiKeyId: "plan-b",
          modelId: "manual-model",
          runtime: { accountLock: "key" },
        });
        expect(fixed.runtime.connectionModels).toBeUndefined();
      });

      it("saves the one plan ticked alone and the model set on it", async () => {
        withPlans(plan("plan-a", "Example Org"), plan("plan-b", "Second Org"));
        const user = userEvent.setup();
        renderNewCopilot();
        await untickCopilot(user);

        await user.click(planWay("Second Org"));
        await user.click(
          within(cardOf(planWay("Second Org"))).getByRole("button", {
            name: "Pick manual model",
          }),
        );
        expect(
          within(cardOf(planWay("Second Org"))).getByText(
            "Every run uses this model.",
          ),
        ).toBeInTheDocument();
        expect(await createCopilot(user)).toMatchObject({
          llmApiKeyId: "plan-b",
          modelId: "manual-model",
          runtime: { accountLock: "key" },
        });
      });

      it("shows a model the runtime sets for a plan as locked, beside the plan whose model is the agent's to set", async () => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: true,
          readOnlyBy: null,
          accounts: {
            connectionModels: { "plan-b": "plan-b-model" },
            connectionModelNames: { "plan-b": "Runtime model" },
          },
        };
        withPlans(plan("plan-a", "Example Org"), plan("plan-b", "Second Org"));
        const user = userEvent.setup();
        renderNewCopilot();
        await untickCopilot(user);
        await user.click(planWay("Example Org"));
        await user.click(planWay("Second Org"));

        const locked = within(cardOf(planWay("Second Org")));
        expect(locked.getByText("An admin locked this model.")).toBeVisible();
        expect(
          locked.getByText("Every run on this plan uses this model."),
        ).toBeInTheDocument();
        const open = within(cardOf(planWay("Example Org")));
        expect(
          open.getByText("Each person who picks this plan picks their model."),
        ).toBeInTheDocument();
        expect(open.queryByText("An admin locked this model.")).toBeNull();
        // The runtime's model is not written on the agent.
        const body = await createCopilot(user);
        expect(body.runtime.connectionModels).toBeUndefined();
      });

      it("shows only the enterprise plan under a rule that names the company's plan, with no box where one plan remains", async () => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: true,
          readOnlyBy: null,
          accounts: { kind: "key" },
        };
        withPlans(plan("plan-a", "Example Org"));
        const user = userEvent.setup();
        renderNewCopilot();

        expect(
          await within(accounts()).findByText(
            /^Enterprise plan: GitHub Copilot Example Org/,
          ),
        ).toBeInTheDocument();
        expect(within(accounts()).queryByRole("checkbox")).toBeNull();
        expect(
          within(accounts()).queryByText(
            "Each person's GitHub Copilot subscription",
          ),
        ).toBeNull();
        expect(screen.queryByText(/^Locked to /)).toBeNull();
        expect(
          screen.queryByText(/sets which accounts run it/),
        ).not.toBeInTheDocument();
        // The lone plan is the connection: its model is optional.
        expect(
          screen.getByText(
            "Each person picks their model on the agent's page, unless you set one here.",
          ),
        ).toBeInTheDocument();
        const body = await createCopilot(user);
        expect(body).toMatchObject({ llmApiKeyId: null, modelId: null });
        expect(body.runtime).not.toHaveProperty("accountLock");
      });

      it("leaves the plans such a rule allows to tick: all of them, or one fixed for every run", async () => {
        runtimePermissions.current = {
          canChange: true,
          canConfigure: true,
          readOnlyBy: null,
          accounts: { kind: "key" },
        };
        withPlans(plan("plan-a", "Example Org"), plan("plan-b", "Second Org"));
        const user = userEvent.setup();
        renderNewCopilot();

        // No subscription card, and every plan open.
        await waitFor(() => expect(planWay("Example Org")).toBeChecked());
        expect(planWay("Second Org")).toBeChecked();
        expect(
          screen.queryByRole("checkbox", {
            name: /Each person's GitHub Copilot subscription/,
          }),
        ).toBeNull();
        // Unticking one settles on the other.
        await user.click(planWay("Second Org"));
        expect(planWay("Example Org")).toBeChecked();
        expect(planWay("Second Org")).not.toBeChecked();
        const body = await createCopilot(user);
        expect(body).toMatchObject({ llmApiKeyId: "plan-a", modelId: null });
        // The kind is the rule's: the agent names no lock.
        expect(body.runtime).not.toHaveProperty("accountLock");
      });

      it("shows each person's Copilot as the one account when no enterprise plan is connected, and asks for no choice", async () => {
        withPlans();
        const user = userEvent.setup();
        render(
          <AgentForm
            agentType="agent"
            sections={["configuration"]}
            initialRuntimeId="copilot"
            initialValues={copilot?.initialValues}
          />,
        );
        expect(
          within(accounts()).getByText(
            "Each person's GitHub Copilot subscription",
          ),
        ).toBeVisible();
        expect(
          within(accounts()).queryByRole("checkbox"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByText("Select at least one option."),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("img", { name: "Choose who pays for its runs" }),
        ).not.toBeInTheDocument();

        await user.type(screen.getByLabelText(/Name/), "Copilot agent");
        await user.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(createAgent).toHaveBeenCalled());
        expect(createAgent.mock.calls[0][0]).toMatchObject({
          runtime: { command: ["archestra-copilot"] },
        });
      });
    });
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

  it("tells the caller's footer that the form is read-only", async () => {
    // The form no longer decides what a viewer sees instead of a submit row:
    // it is embedded in a page that already says why the record cannot be
    // changed, and that page renders no footer at all.
    const footer = vi.fn(() => <span>footer rendered</span>);
    render(
      <AgentFormWithoutFooter
        agentType="agent"
        agent={baseAgent}
        readOnly
        footer={footer}
      />,
    );

    expect(await screen.findByText("footer rendered")).toBeInTheDocument();
    expect(footer).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  });

  it("keeps the caller's own footer when the form is editable", async () => {
    render(<AgentForm agentType="agent" agent={baseAgent} />);

    expect(
      await screen.findByRole("button", { name: /update/i }),
    ).toBeInTheDocument();
  });
});
