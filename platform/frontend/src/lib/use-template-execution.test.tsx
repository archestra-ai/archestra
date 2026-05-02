import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateRequirements } from "./agent-templates.query";
import { useTemplateExecution } from "./use-template-execution";

const pushMock = vi.fn();
const createProfileMock = vi.fn();
const deleteProfileMock = vi.fn();
const bulkAssignMock = vi.fn();
const installMock = vi.fn();
const triggerInstallByCatalogIdAndWaitMock = vi.fn();
const triggerInstallByCatalogIdMock = vi.fn();

const { toastWarningMock, toastErrorMock, toastLoadingMock, toastSuccessMock } =
  vi.hoisted(() => ({
    toastWarningMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastLoadingMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({
  toast: {
    loading: (...args: unknown[]) => toastLoadingMock(...args),
    warning: toastWarningMock,
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock("@/lib/agent.query", () => ({
  useCreateProfile: () => ({
    mutateAsync: createProfileMock,
    isPending: false,
  }),
  useDeleteProfile: () => ({
    mutateAsync: deleteProfileMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useBulkAssignTools: () => ({
    mutateAsync: bulkAssignMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useInstallMcpServer: () => ({
    mutateAsync: installMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: () => ({
    triggerInstallByCatalogId: triggerInstallByCatalogIdMock,
    triggerInstallByCatalogIdAndWait: triggerInstallByCatalogIdAndWaitMock,
  }),
}));

vi.mock("@shared", async () => {
  const actual = await vi.importActual<typeof import("@shared")>("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getAgentTemplateRequirements: vi.fn(),
    },
  };
});

const baseRequirements: TemplateRequirements = {
  templateId: "code-reviewer",
  agentConfig: {
    name: "Code Reviewer",
    description: "Reviews repositories and issues.",
    systemPrompt: "Review carefully.",
    llmModel: null,
    labels: [{ key: "template", value: "code-reviewer" }],
    agentType: "agent",
    scope: "personal",
    teams: [],
  },
  toolAssignments: [
    {
      toolId: "tool-github",
      catalogId: "github-catalog",
      credentialResolutionMode: "static",
      requiresUserConfig: true,
    },
    {
      toolId: "tool-slack",
      catalogId: "slack-catalog",
      credentialResolutionMode: "dynamic",
      requiresUserConfig: false,
    },
  ],
  missingCatalogs: [
    {
      catalogId: "github-catalog",
      catalogName: "github",
      serverType: "remote",
      requiresOauth: false,
      userConfigFields: [
        {
          key: "token",
          type: "string",
          title: "Token",
          description: "API token",
          required: true,
        },
      ],
      environmentFields: [
        {
          key: "GITHUB_HOST",
          type: "plain_text",
          promptOnInstallation: true,
          description: "Host override",
        },
      ],
      canAutoInstall: false,
    },
    {
      catalogId: "slack-catalog",
      catalogName: "slack",
      serverType: "remote",
      requiresOauth: false,
      userConfigFields: [],
      environmentFields: [],
      canAutoInstall: true,
    },
  ],
  unavailableTools: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useTemplateExecution", () => {
  const onOpenChangeMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createProfileMock.mockResolvedValue({ id: "agent-1" });
    deleteProfileMock.mockResolvedValue({ success: true });
    installMock.mockResolvedValue({
      installedServer: { id: "server-slack" },
    });
    triggerInstallByCatalogIdMock.mockReset();
    triggerInstallByCatalogIdAndWaitMock.mockResolvedValue({
      installedServerId: "server-github",
      completed: true,
    });
    bulkAssignMock.mockResolvedValue({
      succeeded: [
        { agentId: "agent-1", toolId: "tool-github" },
        { agentId: "agent-1", toolId: "tool-slack" },
      ],
      failed: [],
      duplicates: [],
    });
    vi.mocked(archestraApiSdk.getAgentTemplateRequirements).mockResolvedValue({
      data: baseRequirements,
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.getAgentTemplateRequirements>
    >);
  });

  it("creates agent, installs servers, assigns tools, and redirects to chat", async () => {
    const { result } = renderHook(() => useTemplateExecution(), {
      wrapper: createWrapper(),
    });

    await result.current.execute({
      requirements: baseRequirements,
      formValues: {
        "github-catalog::userConfig::token": "secret-token",
        "github-catalog::environment::GITHUB_HOST": "github.example.com",
      },
      onOpenChange: onOpenChangeMock,
    });

    await waitFor(() => {
      expect(createProfileMock).toHaveBeenCalledWith(
        baseRequirements.agentConfig,
      );
    });

    expect(installMock).toHaveBeenCalledWith({
      name: "slack",
      catalogId: "slack-catalog",
      scope: "personal",
      agentIds: ["agent-1"],
      dontShowToast: true,
    });
    expect(triggerInstallByCatalogIdAndWaitMock).toHaveBeenCalledWith({
      catalogId: "github-catalog",
      installationData: {
        environmentValues: {
          GITHUB_HOST: "github.example.com",
        },
        userConfigValues: {
          token: "secret-token",
        },
        scope: "personal",
        agentIds: ["agent-1"],
      },
    });
    expect(triggerInstallByCatalogIdMock).not.toHaveBeenCalled();
    expect(bulkAssignMock).toHaveBeenCalledWith({
      assignments: [
        {
          agentId: "agent-1",
          toolId: "tool-github",
          mcpServerId: "server-github",
          credentialResolutionMode: "static",
        },
        {
          agentId: "agent-1",
          toolId: "tool-slack",
          mcpServerId: "server-slack",
          credentialResolutionMode: "dynamic",
          resolveAtCallTime: true,
        },
      ],
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Code Reviewer created", {
      id: "template-progress",
    });
    expect(pushMock).toHaveBeenCalledWith("/chat");
    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });

  it("redirects to /agents when manual install remains incomplete", async () => {
    triggerInstallByCatalogIdAndWaitMock.mockResolvedValue({
      installedServerId: null,
      completed: false,
    });

    const { result } = renderHook(() => useTemplateExecution(), {
      wrapper: createWrapper(),
    });

    await result.current.execute({
      requirements: baseRequirements,
      formValues: {
        "github-catalog::userConfig::token": "secret-token",
        "github-catalog::environment::GITHUB_HOST": "github.example.com",
      },
      onOpenChange: onOpenChangeMock,
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/agents");
    });
    expect(toastWarningMock).toHaveBeenCalledWith(
      "Provisioning for github needs follow-up",
      { id: "template-progress" },
    );
    expect(bulkAssignMock).toHaveBeenCalledWith({
      assignments: [
        {
          agentId: "agent-1",
          toolId: "tool-github",
          mcpServerId: null,
          credentialResolutionMode: "static",
        },
        {
          agentId: "agent-1",
          toolId: "tool-slack",
          mcpServerId: "server-slack",
          credentialResolutionMode: "dynamic",
          resolveAtCallTime: true,
        },
      ],
    });
  });

  it("rolls back the created agent when bulk assignment throws", async () => {
    bulkAssignMock.mockRejectedValue(new Error("assign failed"));

    const { result } = renderHook(() => useTemplateExecution(), {
      wrapper: createWrapper(),
    });

    await result.current.execute({
      requirements: baseRequirements,
      formValues: {
        "github-catalog::userConfig::token": "secret-token",
        "github-catalog::environment::GITHUB_HOST": "github.example.com",
      },
      onOpenChange: onOpenChangeMock,
    });

    await waitFor(() => {
      expect(deleteProfileMock).toHaveBeenCalledWith("agent-1");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Failed to assign template tools",
      { id: "template-progress" },
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("rolls back the created agent when bulk assignment reports failed assignments", async () => {
    bulkAssignMock.mockResolvedValue({
      succeeded: [{ agentId: "agent-1", toolId: "tool-slack" }],
      failed: [{ agentId: "agent-1", toolId: "tool-github" }],
      duplicates: [],
    });

    const { result } = renderHook(() => useTemplateExecution(), {
      wrapper: createWrapper(),
    });

    await result.current.execute({
      requirements: baseRequirements,
      formValues: {
        "github-catalog::userConfig::token": "secret-token",
        "github-catalog::environment::GITHUB_HOST": "github.example.com",
      },
      onOpenChange: onOpenChangeMock,
    });

    await waitFor(() => {
      expect(deleteProfileMock).toHaveBeenCalledWith("agent-1");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Failed to assign template tools",
      { id: "template-progress" },
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("warns when auto-install finishes without an installed server id", async () => {
    installMock.mockResolvedValueOnce({ installedServer: null });

    const { result } = renderHook(() => useTemplateExecution(), {
      wrapper: createWrapper(),
    });

    await result.current.execute({
      requirements: baseRequirements,
      formValues: {
        "github-catalog::userConfig::token": "secret-token",
        "github-catalog::environment::GITHUB_HOST": "github.example.com",
      },
      onOpenChange: onOpenChangeMock,
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/agents");
    });
    expect(toastWarningMock).toHaveBeenCalledWith(
      "Failed to auto-install slack",
      { id: "template-progress" },
    );
  });
});
