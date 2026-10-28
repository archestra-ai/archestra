import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { useInteractionSessions } from "@/lib/interactions/interaction.query";
import { useOrganization } from "@/lib/organization.query";
import LlmProxyLogsPage from "./page.client";

// The cmdk-backed picker reaches for pointer-capture / scrollIntoView /
// ResizeObserver, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Legacy behavior fixtures remain local; real HTTP paging is covered by the
// remote-selector integration suite.
const agentOptions = vi.hoisted(() => ({ rows: [] as unknown[] }));
const agentRows = () => ({ data: agentOptions.rows as never[] });
vi.mock("@/lib/agent-options.query", () => ({
  useAgentOptionsByIds: () => agentRows(),
  useAgentOptionIds: () => ({
    data: (agentRows().data ?? []).map((row: { id: string }) => row.id),
    isSuccess: true,
  }),
  useAgentOptionsPage: (params: { search?: string }) => {
    const result = agentRows();
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

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");

vi.mock("@/lib/interactions/interaction.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/interactions/interaction.query")
  >()),
  useInteractionSessions: vi.fn(),
}));

// Two users can each name their own agent "My Agent", so the filter has to
// carry enough context to tell them apart.
const personalProxy = {
  id: "p1",
  name: "My Proxy",
  agentType: "agent",
  scope: "personal",
  authorEmail: "owner@example.com",
};

const orgProxy = {
  id: "p2",
  name: "Shared Proxy",
  agentType: "agent",
  scope: "org",
};

const push = vi.fn();

function makePagination() {
  return {
    limit: 10,
    nextCursor: null,
    hasNext: false,
  };
}

type SessionSummary =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

function makeSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "demo-session",
    sessionSource: null,
    source: "api",
    sources: ["api"],
    interactionId: null,
    requestCount: 1,
    failedOverCount: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: "0.01",
    totalBilledCost: "0.01",
    totalSubscriptionCost: null,
    totalBaselineCost: "0.01",
    totalCacheSavings: null,
    firstRequestTime: "2026-08-23T16:20:00.000Z",
    lastRequestTime: "2026-08-23T16:30:00.000Z",
    models: ["gpt-5.4"],
    profileId: orgProxy.id,
    profileName: orgProxy.name,
    profileAgentType: "llm_proxy",
    externalAgentIds: [],
    externalAgentIdLabels: [],
    authMethods: [],
    authenticatedAppNames: [],
    userNames: [],
    userIds: [],
    unattributedReason: null,
    virtualKeys: [],
    lastUserMessagePreview: null,
    lastInteractionId: null,
    lastInteractionType: null,
    contentNotStored: false,
    conversationTitle: null,
    claudeCodeTitle: null,
    connectorName: null,
    ...overrides,
  };
}

// role="combobox" takes no accessible name from its contents, so the trigger is
// addressed by the label it renders.
async function openProxyFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("All Agents"));
}

describe("LlmProxyLogsPage proxy filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/llm/logs");
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    agentOptions.rows = [personalProxy, orgProxy];
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [], pagination: makePagination() },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useOrganization>);
  });

  it("shows the owner email of a personal proxy alongside its name", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);

    const option = await screen.findByRole("option", { name: /My Proxy/ });
    expect(within(option).getByText("owner@example.com")).toBeVisible();
  });

  it("shows no owner email for a non-personal proxy", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);

    const option = await screen.findByRole("option", { name: /Shared Proxy/ });
    expect(within(option).queryByText("owner@example.com")).toBeNull();
  });

  // This page keeps its filter in the URL rather than local state, so picking a
  // proxy is observable as the query params it writes (and the session query
  // re-derives from there on the next render).
  it("filters sessions by the picked proxy without offset pagination params", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);
    await user.click(await screen.findByText("My Proxy"));

    expect(push).toHaveBeenCalledWith("/llm/logs?profileId=p1", {
      scroll: false,
    });
  });

  it("presents session context and usage without separate source and details columns", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            sessionId: "demo-session",
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            lastUserMessagePreview: "Summarize the quarterly report",
            requestCount: 3,
            totalInputTokens: 100,
            totalCacheReadTokens: 50,
            totalCacheWriteTokens: 50,
            models: ["gpt-5.4", "gpt-5.4-mini"],
            userNames: ["Demo Admin"],
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    for (const header of [
      "Session",
      "Agent",
      "Model",
      "Usage",
      "Last request",
    ]) {
      expect(
        screen.getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("Summarize the quarterly report")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Demo Admin via API" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /3 requests,.*100 input tokens/ }),
    ).toBeVisible();
    expect(screen.getByText("150 tokens")).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Spend" })).toBeNull();
    expect(screen.getByText("GPT-5.4")).toBeVisible();
    expect(screen.getByText("+ 1 more model")).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Details" })).toBeNull();
  });

  // Naming the key is the point: a shared-key session used to render only
  // "No user — shared key", which says a virtual key was used but not which.
  it("names the virtual key a session ran on", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: [],
            unattributedReason: "shared_virtual_key",
            virtualKeys: [
              {
                id: "vk-1",
                name: "ci-runners",
                scope: "org",
                keyType: "standard",
                tokenStart: "archestra_ab",
                ownerUserId: null,
                ownerUserName: null,
                teams: [],
                createdByUserName: "Demo Admin",
              },
            ],
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("ci-runners")).toBeVisible();
    expect(screen.getByText("org")).toBeVisible();
    expect(screen.getByText("Shared key")).toBeVisible();
  });

  it("names the key and its owner for an attributed session", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: ["Demo Admin"],
            unattributedReason: null,
            virtualKeys: [
              {
                id: "vk-2",
                name: "demo-admin-laptop",
                scope: "personal",
                keyType: "standard",
                tokenStart: "archestra_cd",
                ownerUserId: "u-1",
                ownerUserName: "Demo Admin",
                teams: [],
                createdByUserName: "Demo Admin",
              },
            ],
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("demo-admin-laptop")).toBeVisible();
    expect(screen.getByText("Demo Admin")).toBeVisible();
  });

  it("shows no key badge for a session that used none", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: [],
            unattributedReason: "provider_key",
            virtualKeys: [],
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(
      screen.getByRole("button", { name: "Provider key via API" }),
    ).toBeVisible();
    expect(screen.queryByText(/archestra_/)).toBeNull();
  });

  it("says a Metadata only session's content was not stored", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [makeSessionSummary({ contentNotStored: true })],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("Content not stored")).toBeVisible();
    expect(screen.queryByText("No message")).toBeNull();
  });

  // The knowledge base has no prompt, and the row already says "Knowledge
  // base", so the title says what the call did rather than repeating it.
  it("titles a knowledge-base row by its task without repeating its source", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            source: "knowledge:embedding",
            sources: ["knowledge:embedding"],
            profileId: null,
            profileName: null,
            unattributedReason: "internal",
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("Embedding documents")).toBeVisible();
    expect(screen.queryByText("Knowledge - Embedding")).toBeNull();
    expect(screen.queryByText("Deleted LLM proxy")).toBeNull();
  });

  // Every cell's tooltip trigger is a button; a click on one must still open
  // the row, while the chat link goes to the chat instead.
  it("opens the session from anywhere in the row except the chat link", async () => {
    const user = userEvent.setup();
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            sessionId: "chat-session",
            source: "chat",
            sources: ["chat"],
            conversationTitle: "Quarterly planning",
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    await user.click(screen.getByText("GPT-5.4"));
    expect(push).toHaveBeenCalledWith("/llm/logs/chat-session");

    push.mockClear();
    const chatLink = screen.getByRole("link", { name: "Open chat" });
    expect(chatLink).toHaveAttribute("href", "/chat/chat-session");
    await user.click(chatLink);
    expect(push).not.toHaveBeenCalled();
  });

  it("opens a sessionless interaction as a session of its own", async () => {
    const user = userEvent.setup();
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            sessionId: null,
            interactionId: "interaction-1",
            lastUserMessagePreview: "One-off request",
          }),
        ],
        pagination: makePagination(),
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    await user.click(screen.getByText("One-off request"));
    expect(push).toHaveBeenCalledWith("/llm/logs/interaction-1");
  });
});
