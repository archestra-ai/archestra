import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { InitialAgentSelector } from "./initial-agent-selector";

const {
  agents,
  mockUseAgentCredentialReadiness,
  mockUseAgentDelegations,
  mockUseAllProfileTools,
  mockUseConnectors,
  mockUseInternalMcpCatalog,
  mockUseKnowledgeBases,
  mockUseMcpInstallOrchestrator,
  mockUseProfile,
} = vi.hoisted(() => ({
  agents: [
    {
      id: "agent-1",
      name: "Alpha Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
    {
      id: "agent-2",
      name: "Beta Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
    {
      id: "agent-3",
      name: "Gamma Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
  ],
  mockUseAgentCredentialReadiness: vi.fn((_options?: unknown) => ({
    data: undefined,
  })),
  mockUseAgentDelegations: vi.fn((_agentId?: string, _options?: unknown) => ({
    data: [],
  })),
  mockUseAllProfileTools: vi.fn((_options?: unknown) => ({
    data: { data: [] },
  })),
  mockUseConnectors: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseInternalMcpCatalog: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseKnowledgeBases: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseMcpInstallOrchestrator: vi.fn((_options?: unknown) => ({
    closeLocalInstall: vi.fn(),
    closeNoAuthInstall: vi.fn(),
    closeOAuth: vi.fn(),
    handleLocalServerInstallConfirm: vi.fn(),
    handleNoAuthConfirm: vi.fn(),
    handleOAuthConfirm: vi.fn(),
    handleRemoteServerInstallConfirm: vi.fn(),
    isDialogOpened: () => false,
    isInstalling: false,
    isReauth: false,
    localServerCatalogItem: null,
    noAuthCatalogItem: null,
    selectedCatalogItem: null,
    triggerInstallByCatalogId: vi.fn(),
  })),
  mockUseProfile: vi.fn((id: string | undefined, _options?: unknown) => ({
    data: agents.find((agent) => agent.id === id),
  })),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/lib/agent.query", () => ({
  useAgentCredentialReadiness: (options?: unknown) =>
    mockUseAgentCredentialReadiness(options),
  useChatAgents: () => ({ data: agents }),
  useCreateProfile: () => ({ mutate: vi.fn() }),
  useInternalAgents: () => ({ data: agents }),
  useProfile: (id: string | undefined, options?: unknown) =>
    mockUseProfile(id, options),
  useUpdateProfile: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: (agentId?: string, options?: unknown) =>
    mockUseAgentDelegations(agentId, options),
  useAllProfileTools: (options?: unknown) => mockUseAllProfileTools(options),
  useAssignTool: () => ({ mutate: vi.fn() }),
  useRemoveAgentDelegation: () => ({ mutate: vi.fn() }),
  useSyncAgentDelegations: () => ({ mutate: vi.fn() }),
  useUnassignTool: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: (options?: unknown) => mockUseConnectors(options),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: (options?: unknown) => mockUseKnowledgeBases(options),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  fetchCatalogTools: vi.fn(),
  useCatalogTools: () => ({ data: [] }),
  useInternalMcpCatalog: (options?: unknown) =>
    mockUseInternalMcpCatalog(options),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: (options?: unknown) =>
    mockUseMcpInstallOrchestrator(options),
}));

vi.mock("@/components/chat/mcp-install-dialogs", () => ({
  McpInstallDialogs: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/local-server-install-dialog", () => ({
  LocalServerInstallDialog: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/no-auth-install-dialog", () => ({
  NoAuthInstallDialog: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/remote-server-install-dialog", () => ({
  RemoteServerInstallDialog: () => null,
}));
vi.mock("@/components/oauth-confirmation-dialog", () => ({
  OAuthConfirmationDialog: () => null,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useFeature).mockReturnValue(false);
});

describe("InitialAgentSelector keyboard navigation", () => {
  it("moves through agents with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    render(
      <InitialAgentSelector
        currentAgentId="agent-1"
        onAgentChange={onAgentChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const search = await screen.findByRole("combobox", {
      name: "Search agents",
    });

    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Alpha Agent/ }).id,
    );

    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Beta Agent/ }).id,
    );

    await user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Alpha Agent/ }).id,
    );

    await user.keyboard("{ArrowUp}{Enter}");
    expect(onAgentChange).toHaveBeenCalledWith("agent-3");
  });

  it("defers management queries until the picker opens", async () => {
    const user = userEvent.setup();
    render(
      <InitialAgentSelector currentAgentId="agent-1" onAgentChange={vi.fn()} />,
    );

    expect(mockUseAgentCredentialReadiness).toHaveBeenLastCalledWith({
      enabled: false,
    });
    expect(mockUseInternalMcpCatalog).toHaveBeenLastCalledWith({
      enabled: false,
    });
    expect(mockUseAllProfileTools).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(mockUseKnowledgeBases).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockUseConnectors).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", { enabled: false });

    await user.click(screen.getByRole("combobox"));

    expect(mockUseAgentCredentialReadiness).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(mockUseInternalMcpCatalog).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(mockUseAllProfileTools).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(mockUseKnowledgeBases).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockUseConnectors).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", { enabled: true });
  });
});
