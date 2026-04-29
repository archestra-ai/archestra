import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./agent-dialog";

const {
  pendingSaveChanges,
  useAvailableLlmProviderApiKeysMock,
  useHasPermissionsMock,
  useInternalAgentsMock,
  useLlmModelsByProviderMock,
} = vi.hoisted(() => ({
  pendingSaveChanges: vi.fn(
    () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ),
  useInternalAgentsMock: vi.fn(() => ({ data: [] })),
  useAvailableLlmProviderApiKeysMock: vi.fn(() => ({ data: [] })),
  useLlmModelsByProviderMock: vi.fn(() => ({ modelsByProvider: {} })),
  useHasPermissionsMock: vi.fn((..._args: unknown[]) => ({ data: true })),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => ({ data: [] }),
  };
});

vi.mock("@/lib/agent.query", () => ({
  useCreateProfile: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteProfile: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useInternalAgents: useInternalAgentsMock,
  useProfile: () => ({ data: null, refetch: vi.fn() }),
  useUpdateProfile: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: () => ({ data: [] }),
  useSyncAgentDelegations: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: useHasPermissionsMock,
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useChatProfileMcpTools: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => ({ data: [] }),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => ({ data: [] }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: useLlmModelsByProviderMock,
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: useAvailableLlmProviderApiKeysMock,
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

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

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
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

vi.mock("@/components/ui/assignment-combobox", () => ({
  AssignmentCombobox: () => null,
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
  Switch: () => null,
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

describe.skip("AgentDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHasPermissionsMock.mockImplementation(() => ({ data: true }));
  });

  it("does not eagerly enable agent-only queries for a closed MCP gateway dialog", () => {
    render(
      <AgentDialog
        open={false}
        onOpenChange={vi.fn()}
        agentType="mcp_gateway"
      />,
    );

    expect(useInternalAgentsMock).toHaveBeenCalledWith({ enabled: false });
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
          scope: "personal",
          isDefault: false,
          isPersonalGateway: false,
          teams: [],
          tools: [],
          labels: [],
          authorId: "user-1",
          authorName: "Test User",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          knowledgeBaseIds: [],
          connectorIds: [],
          suggestedPrompts: [],
          llmApiKeyId: null,
          llmModel: null,
          considerContextUntrusted: false,
          identityProviderId: null,
          builtInAgentConfig: null,
          passthroughHeaders: null,
          toolAssignmentMode: "manual",
          incomingEmailEnabled: false,
          incomingEmailSecurityMode: "public",
          incomingEmailAllowedDomain: null,
          slug: null,
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
    useHasPermissionsMock.mockImplementation((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      if ("llmProviderApiKey" in permissions || "llmModel" in permissions) {
        return { data: false };
      }
      return { data: true };
    });

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
    useHasPermissionsMock.mockImplementation((...args: unknown[]) => {
      const permissions = (args[0] ?? {}) as Record<string, unknown>;
      if ("llmProviderApiKey" in permissions || "llmModel" in permissions) {
        return { data: false };
      }
      return { data: true };
    });

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
