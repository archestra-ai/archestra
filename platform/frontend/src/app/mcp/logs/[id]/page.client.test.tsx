import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptions } from "@/lib/agent.query";
import {
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import {
  useMcpToolCall,
  useMcpToolCalls,
  useSessionMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import { McpToolCallDetailPage } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/agent.query", () => ({ useAgentOptions: vi.fn() }));

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteraction: vi.fn(),
  useInteractionSummaries: vi.fn(),
  useInteractionSessions: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-tool-call.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-tool-call.query")>()),
  useMcpToolCall: vi.fn(),
  useMcpToolCalls: vi.fn(),
  useSessionMcpToolCalls: vi.fn(),
}));

vi.mock("@/lib/mcp-logs/use-mcp-server-display", () => ({
  useMcpServerDisplayByName: () => ({
    servers: [],
    displayByName: new Map(),
  }),
}));

describe("McpToolCallDetailPage", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue(`/mcp/logs/${CALL_ID}`);
    vi.mocked(useAgentOptions).mockReturnValue({
      data: [{ id: "agent-1", name: "Release Bot" }],
    } as unknown as ReturnType<typeof useAgentOptions>);
    vi.mocked(useInteraction).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useInteraction>);
    mockSession(undefined);
    mockSummaries([]);
    vi.mocked(useSessionMcpToolCalls).mockReturnValue({
      data: [],
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useSessionMcpToolCalls>);
    mockNearbyCalls([]);
  });

  it("shows a linked call inside its session, with a link to the full trace", async () => {
    mockCall({ sessionId: SESSION_ID });
    mockSession({ sessionId: SESSION_ID, requestCount: 3 });
    mockSummaries([
      summary({ id: "req-1", createdAt: "2026-10-16T10:00:00.000Z" }),
    ]);

    renderPage();

    const excerpt = await screen.findByRole("region", {
      name: "Session excerpt",
    });
    expect(
      within(excerpt).getByRole("link", { name: "Open full trace" }),
    ).toHaveAttribute("href", `/llm/logs/${SESSION_ID}?toolCall=${CALL_ID}`);
    expect(
      screen.getByRole("link", { name: `Session ${SESSION_ID}` }),
    ).toBeVisible();
    expect(screen.queryByText("Nearby calls")).not.toBeInTheDocument();
  });

  it("shows an unlinked call among its owner's nearby calls and says why", async () => {
    mockCall({ sessionId: null });
    mockNearbyCalls([
      record({ id: "neighbour-1", createdAt: "2026-10-16T10:02:00.000Z" }),
    ]);

    renderPage();

    expect(
      await screen.findByRole("region", { name: "Nearby calls" }),
    ).toBeVisible();
    expect(screen.getByText("Not linked to an LLM session")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open full trace" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to nearby calls when the linked session is gone", async () => {
    mockCall({ sessionId: SESSION_ID });
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [] },
      isSuccess: true,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    renderPage();

    expect(
      await screen.findByRole("region", { name: "Nearby calls" }),
    ).toBeVisible();
    expect(screen.getByText("no longer available")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: `Session ${SESSION_ID}` }),
    ).not.toBeInTheDocument();
  });

  it("names a call the platform refused as blocked, with the refusal", async () => {
    mockCall({
      toolResult: {
        isError: true,
        content: [{ type: "text", text: "Tool is not enabled for this agent" }],
        _meta: {
          archestraError: {
            type: "tool_state",
            code: "tool_not_enabled",
            message: "Tool is not enabled for this agent",
            toolName: "github__search_issues",
          },
        },
      },
    });

    renderPage();

    const facts = await screen.findByRole("region", {
      name: "Tool call facts",
    });
    expect(within(facts).getByText("Blocked")).toBeVisible();
    expect(screen.getByText("Blocked, not run")).toBeVisible();
    expect(
      screen.getAllByText("Tool is not enabled for this agent").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("The call failed")).not.toBeInTheDocument();
  });

  it("states why a failed call failed", async () => {
    mockCall({
      toolResult: {
        isError: true,
        content: [{ type: "text", text: "statement timeout" }],
      },
    });

    renderPage();

    const notice = (await screen.findByText("The call failed")).closest(
      "[role]",
    ) as HTMLElement;
    expect(within(notice).getByText("statement timeout")).toBeVisible();
  });

  it("marks a cancelled call as cancelled rather than failed", async () => {
    mockCall({
      toolResult: {
        isError: true,
        _meta: { archestraError: { type: "cancelled", message: "stopped" } },
      },
    });

    renderPage();

    const facts = await screen.findByRole("region", {
      name: "Tool call facts",
    });
    expect(within(facts).getByText("Cancelled")).toBeVisible();
    expect(screen.queryByText("The call failed")).not.toBeInTheDocument();
  });

  it("lists the tools a tools/list call returned, with the raw JSON a toggle away", async () => {
    const user = userEvent.setup();
    mockCall({
      method: "tools/list",
      toolCall: null,
      toolResult: {
        tools: [
          { name: "search_issues", description: "Search the issue tracker" },
          { name: "create_issue" },
        ],
      },
    });

    renderPage();

    const tools = await screen.findByRole("list", { name: "Listed tools" });
    expect(within(tools).getByText("search_issues")).toBeVisible();
    expect(within(tools).getByText("Search the issue tracker")).toBeVisible();
    expect(within(tools).getByText("create_issue")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(
      screen.queryByRole("list", { name: "Listed tools" }),
    ).not.toBeInTheDocument();
  });

  it("says so when a call recorded no arguments and no result", async () => {
    mockCall({
      toolCall: { id: "tc-1", name: "github__ping", arguments: {} },
      toolResult: null,
    });

    renderPage();

    expect(await screen.findByText("No arguments recorded.")).toBeVisible();
    expect(screen.getByText("No result recorded.")).toBeVisible();
  });
});

// ============================================================================
// Internal helpers
// ============================================================================

type McpToolCallRecord = archestraApiTypes.GetMcpToolCallResponses["200"];

const CALL_ID = "08b4ea65-7008-4651-875b-deab89cee1d8";
const SESSION_ID = "7d1c2e9a-4b6f-4c1e-9a3d-5e8f0b2c4d61";

function renderPage() {
  return render(<McpToolCallDetailPage id={CALL_ID} />);
}

function record(overrides: Partial<McpToolCallRecord> = {}): McpToolCallRecord {
  return {
    id: CALL_ID,
    ownerType: "agent",
    agentId: "agent-1",
    appId: null,
    mcpServerName: "github",
    method: "tools/call",
    toolCall: {
      id: "tc-1",
      name: "github__search_issues",
      arguments: { query: "is:open" },
    },
    toolResult: {
      isError: false,
      content: [{ type: "text", text: "3 open issues" }],
    },
    userId: "user-1",
    runId: null,
    sessionId: null,
    llmToolCallId: null,
    authMethod: "oauth",
    oauthClientId: null,
    source: "api",
    durationMs: 812,
    createdAt: "2026-10-16T10:00:30.000Z",
    userName: "Admin",
    appName: null,
    ...overrides,
  } as McpToolCallRecord;
}

function mockCall(overrides: Partial<McpToolCallRecord>) {
  vi.mocked(useMcpToolCall).mockReturnValue({
    data: record(overrides),
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMcpToolCall>);
}

function mockSession(
  session: { sessionId: string; requestCount: number } | undefined,
) {
  vi.mocked(useInteractionSessions).mockReturnValue({
    data: session ? { data: [session] } : undefined,
    isSuccess: session !== undefined,
  } as unknown as ReturnType<typeof useInteractionSessions>);
}

function summary(overrides: { id: string; createdAt: string }) {
  return {
    sessionId: SESSION_ID,
    type: "anthropic:messages",
    model: "claude-opus-4-8",
    profileName: "Release Bot",
    inputTokens: 100,
    outputTokens: 20,
    cost: "0.01",
    durationMs: 1200,
    requestType: "main",
    ...overrides,
  };
}

function mockSummaries(rows: ReturnType<typeof summary>[]) {
  vi.mocked(useInteractionSummaries).mockReturnValue({
    data: {
      data: rows,
      pagination: {
        currentPage: 1,
        limit: 6,
        total: rows.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isLoading: false,
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useInteractionSummaries>);
}

function mockNearbyCalls(rows: McpToolCallRecord[]) {
  vi.mocked(useMcpToolCalls).mockReturnValue({
    data: {
      data: rows,
      pagination: {
        currentPage: 1,
        limit: 100,
        total: rows.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useMcpToolCalls>);
}
