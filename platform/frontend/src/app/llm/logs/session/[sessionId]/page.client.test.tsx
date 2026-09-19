import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
} from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import {
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation");

// The unattributed-user badge interpolates the white-label app name, and the
// real hook reads it through TanStack Query — which this suite renders without.
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn(() => false),
}));

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteraction: vi.fn(),
  useInteractionSummaries: vi.fn(),
  useInteractionSessions: vi.fn(),
  useExportSessionInteractions: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: () => ({ sessionId: "test-session" }),
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
    vi.mocked(usePathname).mockReturnValue("/llm/logs/session/test-session");
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useInteraction).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useInteraction>);
    vi.mocked(useFeature).mockReturnValue(false);
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
      screen.queryByText("No interactions found for this session"),
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
      screen.queryByText("No interactions found for this session"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading session logs…" }),
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

    expect(
      await screen.findByText(/98,000 cache read \/ 12,000 cache write/),
    ).toBeVisible();
  });

  // Legacy Claude attribution maps to Code; explicit Desktop stays separate.
  it.each([
    [CLAUDE_CLIENT_ID, "Claude Code"],
    [CLAUDE_CODE_CLIENT_ID, "Claude Code"],
    [CLAUDE_DESKTOP_CLIENT_ID, "Claude Desktop"],
  ])("renders the Claude badge for client id '%s'", async (externalAgentId, label) => {
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
      await screen.findByText("No interactions found for this session"),
    ).toBeVisible();
    expect(screen.queryByText(/^Claude/)).not.toBeInTheDocument();
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

    // Both the desktop and mobile pagination layouts render the selector.
    expect(
      (await screen.findAllByText("Rows per page")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Showing 1 to 10 of 120 requests/).length,
    ).toBeGreaterThan(0);
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

    expect(await screen.findByText(/1,250 in/)).toBeVisible();
    expect(screen.queryByText(/cache read/)).not.toBeInTheDocument();
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

    expect(await screen.findByText("Session")).toBeVisible();
    expect(screen.getByText("user:abc|ses_chat_1")).toBeVisible();
    expect(screen.getByText("Session source")).toBeVisible();
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.getByText("Origins")).toBeVisible();
  });

  it("labels the main agent by profile name and a compaction row as compaction, not Main", async () => {
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
        ],
        pagination: { total: 2 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractionSummaries>);

    renderSessionDetailPage();

    expect(await screen.findByText("Chat Compaction")).toBeVisible();
    expect(screen.getAllByText("My Assistant").length).toBeGreaterThan(0);
    expect(screen.queryByText("Main")).not.toBeInTheDocument();
  });
});

function renderSessionDetailPage() {
  return render(
    <SessionDetailPage
      paramsPromise={Promise.resolve({ sessionId: "test-session" })}
    />,
  );
}
