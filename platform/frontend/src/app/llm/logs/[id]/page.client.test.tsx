import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import {
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
  useSessionLineage,
} from "@/lib/interactions/interaction.query";
import {
  useMcpToolCall,
  useSessionMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import { useOrganization } from "@/lib/organization.query";
import type { SessionToolCall } from "./_parts/session-timeline";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation");

// The unattributed-user badge interpolates the white-label app name, and the
// real hook reads it through TanStack Query — which this suite renders without.
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");
// Model vendor names follow the organization's provider renames.
vi.mock("@/lib/organization.query");

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteraction: vi.fn(),
  useInteractionSummaries: vi.fn(),
  useInteractionSessions: vi.fn(),
  useSessionLineage: vi.fn(() => ({ data: undefined })),
  useExportSessionInteractions: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("@/lib/mcp/mcp-tool-call.query", () => ({
  useMcpToolCall: vi.fn(),
  useSessionMcpToolCalls: vi.fn(),
}));
// Server display names come from the installed-server and catalog lists.
// The session's guardrail records: none here.
vi.mock("@/lib/openappa/external-consults.query", () => ({
  useSessionConsults: () => ({ data: [] }),
}));
vi.mock("@/lib/openappa/label-changes.query", () => ({
  useSessionLabelChanges: () => ({ data: [] }),
}));
vi.mock("@/lib/openappa-yells.query", () => ({
  useSessionYells: () => ({ data: undefined }),
}));
vi.mock("@/lib/mcp-logs/use-mcp-server-display", () => ({
  useMcpServerDisplayByName: () => ({
    servers: [],
    displayByName: new Map([
      ["jira", { name: "Jira Cloud", icon: null, catalogId: "jira-catalog" }],
    ]),
  }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: () => ({ id: "test-session" }),
  };
});

describe("SessionDetailPage", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/llm/logs/test-session");
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteraction).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useInteraction>);
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useOrganization>);
    mockSessionToolCalls([]);
    vi.mocked(useMcpToolCall).mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: false,
    } as unknown as ReturnType<typeof useMcpToolCall>);
  });

  it("says nothing at all while session interactions are loading", async () => {
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    // The wait is reported by the sidebar toggle's spinner, the one place the
    // app says it is loading. What matters here is that the area does not
    // announce an empty result before the fetch has settled.
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText("No requests recorded for this session yet."),
    ).not.toBeInTheDocument();
  });

  it("shows a permission-aware unavailable state when the requested session is not visible", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [],
        pagination: { limit: 1, nextCursor: null, hasNext: false },
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 50,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    expect(
      await screen.findByText(
        "You may not have permission to view this session, or it may no longer exist.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Session unavailable");
    expect(screen.queryByText("Requests")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No requests recorded for this session yet."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading session logs…" }),
    ).not.toBeInTheDocument();
  });

  it("links a forked session to its parent and a parent to its forks", async () => {
    vi.mocked(useFeature).mockReturnValue(true);
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [{ sessionId: "test-session" }] },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);
    vi.mocked(useSessionLineage).mockReturnValue({
      data: {
        forkedFrom: "parent-session",
        forks: ["fork-a", "fork-b"],
        forksTruncated: true,
      },
    } as unknown as ReturnType<typeof useSessionLineage>);

    renderSessionDetailPage();

    expect(await screen.findByText("Forked from")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "parent-session" }),
    ).toHaveAttribute("href", "/llm/logs/parent-session");
    expect(screen.getByText("Forks")).toBeVisible();
    expect(screen.getByRole("link", { name: "fork-b" })).toHaveAttribute(
      "href",
      "/llm/logs/fork-b",
    );
    expect(screen.getByText("Additional forks not shown")).toBeVisible();
  });

  it("hides fork lineage when OpenAPPA is off", async () => {
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [{ sessionId: "test-session" }] },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);
    vi.mocked(useSessionLineage).mockReturnValue({
      data: {
        forkedFrom: "parent-session",
        forks: ["fork-a"],
        forksTruncated: true,
      },
    } as unknown as ReturnType<typeof useSessionLineage>);

    renderSessionDetailPage();

    expect(
      await screen.findByText("No requests recorded for this session yet."),
    ).toBeVisible();
    expect(screen.queryByText("Forked from")).not.toBeInTheDocument();
    expect(screen.queryByText("Fork")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Additional forks not shown"),
    ).not.toBeInTheDocument();
  });

  it("shows cache read/write totals when the session used prompt caching", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          {
            totalInputTokens: 1250,
            totalOutputTokens: 430,
            totalCacheReadTokens: 98000,
            totalCacheWriteTokens: 12000,
          },
        ],
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    // The strip shows the cached share at a glance; the split is on hover.
    // Wide and phone layouts each place the figure, so jsdom sees both.
    const [cached] = await screen.findAllByText("110K cached");
    expect(cached).toBeVisible();
    await userEvent.hover(cached);
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("98,000")).toBeInTheDocument();
    expect(within(tooltip).getByText("12,000")).toBeInTheDocument();
  });

  // Legacy Claude attribution maps to Code; explicit Desktop stays separate.
  it.each([
    [CLAUDE_CLIENT_ID, "Claude Code"],
    [CLAUDE_CODE_CLIENT_ID, "Claude Code"],
    [CLAUDE_DESKTOP_CLIENT_ID, "Claude Desktop"],
    [OPENCODE_CLIENT_ID, "OpenCode"],
  ])("renders the client badge for id '%s'", async (externalAgentId, label) => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [{ externalAgentIds: [externalAgentId] }] },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    expect(await screen.findByText(label)).toBeVisible();
  });

  it("shows no Claude badge for non-Claude clients", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [{ externalAgentIds: ["my-custom-agent"] }] },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    expect(
      await screen.findByText("No requests recorded for this session yet."),
    ).toBeVisible();
    expect(screen.queryByText(/^Claude/)).not.toBeInTheDocument();
  });

  it("labels OpenCode side turns as sub-agent requests", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [{ externalAgentIds: [OPENCODE_CLIENT_ID] }] },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: {
        data: [
          {
            id: "title-request",
            createdAt: "2026-09-19T22:42:41.000Z",
            externalAgentId: OPENCODE_CLIENT_ID,
            requestType: "subagent",
            source: "opencode:subagent",
            model: "title-model",
            inputTokens: 10,
            outputTokens: 2,
            cost: "0",
            billingMode: "metered",
          },
          {
            id: "main-request",
            createdAt: "2026-09-19T22:42:45.000Z",
            externalAgentId: OPENCODE_CLIENT_ID,
            requestType: "main",
            source: "opencode:main",
            model: "main-model",
            inputTokens: 20,
            outputTokens: 4,
            cost: "0",
            billingMode: "metered",
          },
        ],
        pagination: { total: 2 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    const requests = await screen.findByRole("list", { name: "Requests" });
    expect(
      within(requests).getByRole("button", { name: /^Sub-agent, / }),
    ).toBeVisible();
    expect(
      within(requests).getByRole("button", {
        name: new RegExp(`^${OPENCODE_CLIENT_ID}, `),
      }),
    ).toBeVisible();
  });

  it("renders the rows-per-page selector when the session has interactions", async () => {
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 50,
          total: 120,
          totalPages: 3,
          hasNext: true,
          hasPrev: false,
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    // The paging sits in the requests card's status bar.
    expect(
      await screen.findByRole("combobox", { name: "Rows per page" }),
    ).toBeVisible();
    // Fifty rows a page by default.
    expect(screen.getByText("Page 1 of 3")).toBeVisible();
    expect(screen.getByText("1–50 of 120")).toBeVisible();
  });

  it("hides the cache line when the session used no caching", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          {
            totalInputTokens: 1250,
            totalOutputTokens: 430,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
          },
        ],
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    expect(await screen.findByText(/1\.3K in · 430 out/)).toBeVisible();
    expect(screen.queryByText(/cached/)).not.toBeInTheDocument();
  });

  it("states OpenAPPA session identity in the heading when OpenAPPA is on", async () => {
    vi.mocked(useFeature).mockReturnValue(true);
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          {
            sessionId: "user:abc|ses_chat_1",
            sessionSource: "conversation",
            source: "chat",
            sources: ["chat", "chat:compaction"],
            conversationTitle: "Weather in Lisbon",
            profileName: "My Assistant",
            totalInputTokens: 10,
            totalOutputTokens: 4,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
          },
        ],
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    const trajectory = await screen.findByRole("region", {
      name: "Trajectory",
    });
    // The id is shortened in the row; the full one is on hover.
    const sessionId = within(trajectory).getByText("user:abc…");
    await userEvent.hover(sessionId);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "user:abc|ses_chat_1",
    );
    expect(screen.getByText("Grouped by")).toBeVisible();
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.getByText("Sources")).toBeVisible();
  });

  it("labels main-agent and ChatOps rows by profile name while labeling compaction", async () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [{ profileName: "My Assistant" }],
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: {
        data: [
          {
            id: "int-compact",
            createdAt: "2026-09-18T10:00:00.000Z",
            model: "claude-haiku",
            inputTokens: 1,
            outputTokens: 1,
            source: "chat:compaction",
            externalAgentId: null,
            externalAgentIdLabel: null,
          },
          {
            id: "int-main",
            createdAt: "2026-09-18T09:59:00.000Z",
            model: "claude-haiku",
            inputTokens: 2,
            outputTokens: 2,
            source: "chat",
            externalAgentId: null,
            externalAgentIdLabel: null,
          },
          {
            id: "int-slack",
            createdAt: "2026-09-18T09:58:00.000Z",
            model: "claude-haiku",
            inputTokens: 2,
            outputTokens: 2,
            source: "chatops:slack",
            externalAgentId: null,
            externalAgentIdLabel: null,
          },
          {
            id: "int-teams",
            createdAt: "2026-09-18T09:57:00.000Z",
            model: "claude-haiku",
            inputTokens: 2,
            outputTokens: 2,
            source: "chatops:ms-teams",
            externalAgentId: null,
            externalAgentIdLabel: null,
          },
          {
            id: "int-telegram",
            createdAt: "2026-09-18T09:56:00.000Z",
            model: "claude-haiku",
            inputTokens: 2,
            outputTokens: 2,
            source: "chatops:telegram",
            externalAgentId: null,
            externalAgentIdLabel: null,
          },
        ],
        pagination: { total: 5 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    const requests = await screen.findByRole("list", { name: "Requests" });
    const rowNames = within(requests)
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label")?.split(", ")[0]);
    expect(rowNames.sort()).toEqual([
      "Chat Compaction",
      "My Assistant",
      "My Assistant",
      "My Assistant",
      "My Assistant",
    ]);
    for (const channel of ["Slack", "MS Teams", "Telegram", "Main"]) {
      expect(within(requests).queryByText(channel)).not.toBeInTheDocument();
    }
  });
});

describe("SessionDetailPage tool calls", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/llm/logs/test-session");
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [{ profileName: "My Assistant", lastInteractionId: null }],
      },
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteraction).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useInteraction>);
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useMcpToolCall).mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: false,
    } as unknown as ReturnType<typeof useMcpToolCall>);
    vi.mocked(useInteractionSummaries).mockReturnValue({
      data: {
        data: [
          sessionRequest({
            id: "second",
            createdAt: "2026-09-19T10:00:20.000Z",
          }),
          sessionRequest({
            id: "first",
            createdAt: "2026-09-19T10:00:05.000Z",
          }),
        ],
        pagination: { total: 2 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);
  });

  it("lays each tool call between the requests around it and opens it on double-click", async () => {
    mockSessionToolCalls([
      sessionToolCall({
        id: "lookup",
        createdAt: "2026-09-19T10:00:09.000Z",
        toolCall: {
          id: "tc",
          name: "jira__get_issue",
          arguments: { key: "OPS-12" },
        },
        toolResult: {
          isError: false,
          content: [{ type: "text", text: "OPS-12: Rotate keys" }],
        },
      }),
    ]);
    const user = userEvent.setup();

    renderSessionDetailPage();

    const requests = await screen.findByRole("list", { name: "Requests" });
    const rows = within(requests).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^My Assistant, /),
      "Tool call get_issue on Jira Cloud, 1.50s",
      expect.stringMatching(/^My Assistant, /),
    ]);
    expect(
      within(screen.getByRole("list", { name: "Request kinds" })).getByText(
        "Tool call",
      ),
    ).toBeVisible();

    await user.click(rows[1]);

    const overview = screen.getByRole("complementary", {
      name: "Tool call overview",
    });
    expect(within(overview).getByText("Success")).toBeVisible();
    // The result shows once, in the payload pane beside the overview.
    expect(
      within(
        screen.getByRole("region", { name: "Arguments and result" }),
      ).getByText("OPS-12: Rotate keys"),
    ).toBeVisible();
    expect(within(overview).queryByText("OPS-12: Rotate keys")).toBeNull();

    await user.dblClick(rows[1]);
    expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith(
      "/mcp/logs/lookup",
    );
  });

  it("collapses a run_tool dispatch into the tool it ran", async () => {
    mockSessionToolCalls([
      sessionToolCall({
        id: "outer",
        llmToolCallId: "toolu_1",
        toolCall: { id: "a", name: "archestra__run_tool", arguments: {} },
      }),
      sessionToolCall({ id: "inner", llmToolCallId: "toolu_1" }),
    ]);

    renderSessionDetailPage();

    const requests = await screen.findByRole("list", { name: "Requests" });
    const toolRows = within(requests).getAllByRole("button", {
      name: /^Tool call /,
    });
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toHaveAccessibleName(/^Tool call get_issue /);
  });

  it("preselects the tool call named in the URL", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("toolCall=lookup") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockSessionToolCalls([
      sessionToolCall({ id: "lookup", createdAt: "2026-09-19T10:00:09.000Z" }),
    ]);

    renderSessionDetailPage();

    const requests = await screen.findByRole("list", { name: "Requests" });
    expect(
      within(requests).getByRole("button", { name: /^Tool call get_issue/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("complementary", { name: "Tool call overview" }),
    ).toBeVisible();
  });

  it("says when the session's tool calls failed to load", async () => {
    vi.mocked(useSessionMcpToolCalls).mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSessionMcpToolCalls>);

    renderSessionDetailPage();

    expect(await screen.findByText("Tool calls didn't load")).toBeVisible();
    // The requests themselves still render.
    expect(
      within(screen.getByRole("list", { name: "Requests" })).getAllByRole(
        "button",
      ),
    ).toHaveLength(2);
  });
});

function mockSessionToolCalls(calls: SessionToolCall[]) {
  vi.mocked(useSessionMcpToolCalls).mockReturnValue({
    data: { data: calls, pagination: { hasNext: false } },
    isSuccess: true,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useSessionMcpToolCalls>);
}

function sessionRequest(overrides: { id: string; createdAt: string }) {
  return {
    requestType: "main",
    source: "api",
    model: "claude-sonnet-4-5",
    inputTokens: 10,
    outputTokens: 2,
    cost: "0.001",
    billingMode: "metered",
    durationMs: 4_000,
    externalAgentId: null,
    ...overrides,
  };
}

function sessionToolCall(
  overrides: Partial<SessionToolCall> & { id: string },
): SessionToolCall {
  return {
    ownerType: "agent",
    agentId: null,
    appId: null,
    mcpServerName: "jira",
    method: "tools/call",
    toolCall: { id: "tc", name: "jira__get_issue", arguments: {} },
    toolResult: { isError: false, content: [] },
    userId: null,
    runId: null,
    authMethod: "session",
    oauthClientId: null,
    source: "chat",
    durationMs: 1_500,
    createdAt: "2026-09-19T10:00:09.000Z",
    userName: null,
    appName: null,
    sessionId: "test-session",
    llmToolCallId: null,
    ...overrides,
  };
}

function renderSessionDetailPage() {
  return render(
    <SessionDetailPage
      paramsPromise={Promise.resolve({ id: "test-session" })}
    />,
  );
}
