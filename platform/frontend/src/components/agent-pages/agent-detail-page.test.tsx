import { E2eTestId } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDeleteProfile,
  useExportAgent,
  useProfile,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useEnvironments } from "@/lib/environment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { AgentDetailPage } from "./agent-detail-page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/environment.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/agent.query", () => ({
  useProfile: vi.fn(),
  useDeleteProfile: vi.fn(),
  useExportAgent: vi.fn(),
}));

// Everything the header opens is covered by its own tests; the page only has
// to mount them.
vi.mock("./agent-overview", () => ({
  useAgentOverviewFacts: () => [{ label: "Model", value: "overview" }],
}));
vi.mock("./agent-connect-content", () => ({
  AgentConnectContent: () => <div>connect content</div>,
}));
vi.mock("./agent-background-execution-card", () => ({
  AgentBackgroundExecutionCard: () => <div>background execution</div>,
}));
vi.mock("./agent-system-prompt-card", () => ({
  AgentSystemPromptCard: () => <div>system prompt editor</div>,
}));
vi.mock("./agent-executions", () => ({
  AgentExecutions: () => <div>execution history</div>,
}));
vi.mock("@/components/clone-agent-dialog", () => ({
  CloneAgentDialog: () => null,
}));
vi.mock("@/components/agent-version-history-dialog", () => ({
  AgentVersionHistoryDialog: () => null,
}));
vi.mock("@/app/agents/convert-to-skill-dialog", () => ({
  ConvertToSkillDialog: () => null,
}));

let access = {
  resource: "agent",
  canModify: true,
  canEdit: true,
  canCreate: true,
  canDelete: true,
  isBuiltIn: false,
  currentUserId: "me",
  isPending: false,
};
vi.mock("./use-agent-access", () => ({ useAgentAccess: () => access }));

const baseAgent = {
  id: "a1",
  name: "Support Agent",
  agentType: "agent",
  builtIn: false,
  scope: "personal",
  icon: null,
  description: null,
  deletedAt: null,
  teams: [],
  authorId: "me",
  environmentId: null,
};

function mockAgent(agent: unknown) {
  vi.mocked(useProfile).mockReturnValue({
    data: agent,
    isPending: false,
  } as unknown as ReturnType<typeof useProfile>);
}

describe("AgentDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access = { ...access, resource: "agent", isBuiltIn: false };
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [{ id: "env-1", name: "Production" }] },
    } as unknown as ReturnType<typeof useEnvironments>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      id: "default",
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/agents/a1");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useDeleteProfile).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteProfile>);
    vi.mocked(useExportAgent).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useExportAgent>);
    mockAgent(baseAgent);
  });

  it("shows the not-found state for a trashed id, which the API no longer returns", () => {
    mockAgent(null);
    render(<AgentDetailPage kind="agent" id="a1" />);
    expect(screen.getByText("Agent not found")).toBeInTheDocument();
  });

  it("offers a retry when the record could not be loaded at all", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    vi.mocked(useProfile).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useProfile>);

    render(<AgentDetailPage kind="agent" id="a1" />);
    // A failed request is not the same answer as "this agent does not exist".
    expect(screen.queryByText("Agent not found")).toBeNull();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("asks about the record's own resource, not the route family it is shown under", () => {
    // A legacy profile under the gateway pages is authorized as an `agent`,
    // so every permission the page checks for it has to name that resource.
    access = { ...access, resource: "agent" };
    mockAgent({ ...baseAgent, agentType: "profile" });
    render(<AgentDetailPage kind="mcp_gateway" id="a1" />);

    expect(useHasPermissions).toHaveBeenCalledWith({ agent: ["read"] });
    expect(useHasPermissions).not.toHaveBeenCalledWith({
      mcpGateway: ["read"],
    });
  });

  it("has no trash-only state left: no restore, no permanent delete, no trash banner", () => {
    // Defensive: even handed a row carrying `deletedAt`, the page renders its
    // ordinary header — trashed records are not routable, so there is no
    // second mode for them.
    mockAgent({ ...baseAgent, deletedAt: "2026-08-01T00:00:00.000Z" });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /permanently/i })).toBeNull();
    expect(screen.queryByText(/is in the trash/i)).toBeNull();
    // Connect stays on the same page, and Edit stays in the header.
    expect(screen.getByText("connect content")).toBeInTheDocument();
    expect(
      screen.getByTestId(E2eTestId.AgentDetailEditButton),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
  });

  it("shows overview and system prompt editing before connection instructions", () => {
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    const overview = screen.getByText("overview");
    const systemPrompt = screen.getByText("system prompt editor");
    const connect = screen.getByText("connect content");
    expect(
      overview.compareDocumentPosition(systemPrompt) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      systemPrompt.compareDocumentPosition(connect) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Full configuration/i }),
    ).toHaveAttribute("href", "/agents/a1/edit");
  });

  it("keeps the MCP Gateway Overview but moves its environment into the header", () => {
    mockAgent({
      ...baseAgent,
      agentType: "mcp_gateway",
      environmentId: "env-1",
    });
    render(<AgentDetailPage kind="mcp_gateway" id="a1" />);

    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByText("Production")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    expect(screen.queryByText("system prompt editor")).toBeNull();
  });

  it("keeps the focused system prompt editor on the Agent detail page", () => {
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("system prompt editor")).toBeVisible();
  });

  it("omits the connection section for a built-in agent", () => {
    access = { ...access, isBuiltIn: true };
    mockAgent({ ...baseAgent, builtIn: true });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByText("connect content")).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  it("names delegated task history Executions and opens it from the page header", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    mockAgent({ ...baseAgent, backgroundExecution: {} });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(
      screen
        .getAllByRole("link", { name: "Executions" })
        .every(
          (link) => link.getAttribute("href") === "/agents/a1?tab=executions",
        ),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
  });

  it("keeps execution UI invisible when its feature flag is disabled", () => {
    mockAgent({ ...baseAgent, backgroundExecution: {} });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByRole("link", { name: "Executions" })).toBeNull();
    expect(screen.queryByText("background execution")).toBeNull();
  });
});
