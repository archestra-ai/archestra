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

// Everything the page mounts is covered by its own tests; the page only has to
// mount the right one for the tab it is on. The form stub reports which
// section it was asked for, and hands back a dirty-marker so the navigation
// guard can be driven.
vi.mock("@/components/agent-form", () => ({
  AgentForm: (props: {
    sections: string[];
    readOnly?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    footer: (state: {
      isCreate: boolean;
      isSaving: boolean;
      isDirty: boolean;
      canSubmit: boolean;
      readOnly: boolean;
    }) => React.ReactNode;
  }) => (
    <div>
      <span>{`form section: ${props.sections.join(",")}`}</span>
      {props.readOnly && <span>form is read-only</span>}
      <button type="button" onClick={() => props.onDirtyChange?.(true)}>
        make dirty
      </button>
      {props.footer({
        isCreate: false,
        isSaving: false,
        isDirty: true,
        canSubmit: true,
        readOnly: !!props.readOnly,
      })}
    </div>
  ),
}));
vi.mock("./agent-connect-content", () => ({
  AgentConnectContent: () => <div>connect content</div>,
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

function mockSection(section?: string) {
  const search = section ? `section=${section}` : "";
  window.history.replaceState(
    {},
    "",
    `/agents/a1${search ? `?${search}` : ""}`,
  );
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(search) as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
}

describe("AgentDetailPage", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    access = { ...access, resource: "agent", canEdit: true, isBuiltIn: false };
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
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/agents/a1");
    // The in-app navigation guard compares a link's destination against the
    // real document location, so jsdom has to be on the page being rendered
    // or the current tab's own link reads as somewhere else.
    window.history.replaceState({}, "", "/agents/a1");
    mockSection();
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
  });

  it("opens on the editable configuration instead of a read-only summary", () => {
    // The Edit button and the wizard route it opened are gone: the record's
    // settings are the page.
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("form section: configuration")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("puts every section of the record on a tab of the same page", () => {
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(
      // Connect is named for the protocol on the agents family: A2A.
      [
        "General",
        "Tools & Knowledge",
        "Messaging Channels",
        "Advanced",
        "A2A",
      ].map(
        (name) =>
          screen.getAllByRole("link", { name })[0]?.getAttribute("href") ??
          null,
      ),
    ).toEqual([
      "/agents/a1",
      "/agents/a1?section=tools",
      "/agents/a1?section=messaging",
      "/agents/a1?section=advanced",
      "/agents/a1?section=connect",
    ]);
  });

  it("mounts only the form group the current section names", () => {
    mockSection("tools");
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("form section: tools")).toBeVisible();
    expect(screen.queryByText("connect content")).toBeNull();
  });

  it("shows the connection instructions in their own section, with no form", () => {
    mockSection("connect");
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("connect content")).toBeVisible();
    expect(screen.queryByText(/form section/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("corrects a ?section= this record has none of", () => {
    // Executions is an agent-with-background-execution tab; asking for it on a
    // record without one renders Configuration, and the URL is put right so a
    // reload does not keep asking.
    mockSection("executions");
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("form section: configuration")).toBeVisible();
    expect(replace).toHaveBeenCalledWith("/agents/a1", { scroll: false });
  });

  it("guards a tab change while the configuration holds unsaved edits", async () => {
    const user = userEvent.setup();
    render(<AgentDetailPage kind="agent" id="a1" />);

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getAllByRole("link", { name: "Advanced" })[0]);

    expect(screen.getByText(/discard unsaved changes\?/i)).toBeInTheDocument();
    // Nothing has navigated yet: the answer decides.
    expect(replace).not.toHaveBeenCalled();
  });

  it("guards every in-app link while the configuration is dirty, not only its tabs", async () => {
    // The form is the page, so a link the page does not own — the sidebar,
    // anything else on screen — must not discard edits silently either.
    const user = userEvent.setup();
    render(
      <>
        {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
        <a href="/skills">Somewhere else</a>
        <AgentDetailPage kind="agent" id="a1" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getByRole("link", { name: "Somewhere else" }));

    expect(screen.getByText(/discard unsaved changes\?/i)).toBeInTheDocument();
  });

  it("does not ask about leaving the section already on screen", async () => {
    const user = userEvent.setup();
    render(<AgentDetailPage kind="agent" id="a1" />);

    await user.click(screen.getByRole("button", { name: "make dirty" }));
    await user.click(screen.getAllByRole("link", { name: "General" })[0]);

    expect(screen.queryByText(/discard unsaved changes\?/i)).toBeNull();
  });

  it("refuses the configuration in place for a reader who cannot change it", () => {
    // The form used to be a second route the header's Edit button refused to
    // open. It is the page now, so the refusal is stated over the read-only
    // form instead.
    access = { ...access, canEdit: false, canModify: false };
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("form is read-only")).toBeVisible();
    expect(
      screen.getByText(/you can view this agent's configuration/i),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("keeps the MCP Gateway's environment in the header", () => {
    mockAgent({
      ...baseAgent,
      agentType: "mcp_gateway",
      environmentId: "env-1",
    });
    render(<AgentDetailPage kind="mcp_gateway" id="a1" />);

    expect(screen.getByText("Production")).toBeVisible();
  });

  it("renders no tab bar for a built-in record, which has one section", () => {
    access = { ...access, isBuiltIn: true };
    mockAgent({ ...baseAgent, builtIn: true });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("form section: configuration")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Tools & Knowledge" }),
    ).toBeNull();
    expect(screen.queryByText("connect content")).toBeNull();
  });

  it("states the creator on the General section and nowhere else", () => {
    mockAgent({
      ...baseAgent,
      createdBy: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.getByText("Created by")).toBeVisible();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
  });

  it("keeps the creator off the other sections, which repeat the record", () => {
    mockSection("tools");
    mockAgent({
      ...baseAgent,
      createdBy: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByText("Created by")).toBeNull();
  });

  it("omits the creator for a built-in record, which belongs to nobody", () => {
    // Absent rather than present-but-empty, which would read as missing data.
    access = { ...access, isBuiltIn: true };
    mockAgent({ ...baseAgent, builtIn: true });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByText("Created by")).toBeNull();
  });

  it("names delegated task history Executions and gives it a section", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    mockAgent({ ...baseAgent, backgroundExecution: {} });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(
      screen
        .getAllByRole("link", { name: "Executions" })
        .every(
          (link) =>
            link.getAttribute("href") === "/agents/a1?section=executions",
        ),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
  });

  it("keeps execution UI invisible when its feature flag is disabled", () => {
    mockAgent({ ...baseAgent, backgroundExecution: {} });
    render(<AgentDetailPage kind="agent" id="a1" />);

    expect(screen.queryByRole("link", { name: "Executions" })).toBeNull();
    expect(screen.queryByText("execution history")).toBeNull();
  });
});
