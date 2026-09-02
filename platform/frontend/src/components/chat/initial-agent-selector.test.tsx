import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { InitialAgentSelector } from "./initial-agent-selector";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/lib/agent.query", () => ({
  useAgentCredentialReadiness: () => ({ data: undefined }),
  useCreateProfile: () => ({ mutate: vi.fn() }),
  useInternalAgents: () => ({
    data: [
      {
        id: "agent-1",
        name: "Alpha Agent",
        agentType: "agent",
        scope: "org",
        authorId: null,
        description: null,
        icon: null,
        systemPrompt: null,
        backgroundExecution: null,
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
        backgroundExecution: null,
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
        backgroundExecution: null,
        accessAllTools: true,
      },
    ],
  }),
  useUpdateProfile: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: () => ({ data: [] }),
  useAllProfileTools: () => ({ data: { data: [] } }),
  useAssignTool: () => ({ mutate: vi.fn() }),
  useRemoveAgentDelegation: () => ({ mutate: vi.fn() }),
  useSyncAgentDelegations: () => ({ mutate: vi.fn() }),
  useUnassignTool: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => ({ data: [] }),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => ({ data: [] }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  fetchCatalogTools: vi.fn(),
  useCatalogTools: () => ({ data: [] }),
  useInternalMcpCatalog: () => ({ data: [] }),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: () => ({
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
  }),
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
});
