import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { useTeams } from "@/lib/teams/team.query";
import { ALL_ACTOR_TYPES, ALL_OUTCOMES } from "./audit-log-action-labels";
import { AuditLogTable } from "./audit-log-table";

/**
 * Contract: AuditLogTable — compact columns (Activity / Actor / Resource / Time),
 * with network metadata reserved for the detail dialog,
 * resource NAME shown in grid (denormalized, snapshot fallback) for the
 * high-signal picker types only, while the raw resource id stays hidden,
 * detail dialog on row click, URL-driven filters (incl. the entity picker →
 * resourceId) + clear resets page.
 */

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mockUseAuditLogs = vi.fn();
const mockUseMemberSearch = vi.fn();
const mockUseProfilesPaginated = vi.fn();
const mockUseMcpServers = vi.fn();
const mockUseRolesPaginated = vi.fn();
const mockUseEnvironments = vi.fn();
const mockUseApps = vi.fn();
const mockUseSkillsPaginated = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/teams/team.query");

vi.mock("@/lib/audit-log/audit-log.query", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/audit-log/audit-log.query")
  >("@/lib/audit-log/audit-log.query");
  return {
    ...actual,
    useAuditLogs: (...args: unknown[]) => mockUseAuditLogs(...args),
  };
});

vi.mock("@/lib/member.query", () => ({
  useMemberSearch: (...args: unknown[]) => mockUseMemberSearch(...args),
}));

vi.mock("@/lib/agent.query", () => ({
  useProfilesPaginated: (...args: unknown[]) =>
    mockUseProfilesPaginated(...args),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: (...args: unknown[]) => mockUseMcpServers(...args),
}));

vi.mock("@/lib/role.query", () => ({
  useRolesPaginated: (...args: unknown[]) => mockUseRolesPaginated(...args),
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: (...args: unknown[]) => mockUseEnvironments(...args),
}));

vi.mock("@/lib/app.query", () => ({
  useApps: (...args: unknown[]) => mockUseApps(...args),
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: (...args: unknown[]) => mockUseSkillsPaginated(...args),
}));

function makeEvent(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "evt-1",
    eventSequence: 1,
    organizationId: "org-1",
    actorId: "user-1",
    actorType: "user",
    actorName: "Ada Lovelace",
    actorEmail: "ada@example.com",
    impersonatedBy: null,
    impersonatedByEmail: null,
    action: "agent.updated",
    outcome: "success",
    resourceType: "agent",
    resourceId: "agent-123",
    resourceName: null,
    before: { name: "Old name" },
    after: { name: "New name" },
    httpMethod: "PATCH",
    httpPath: "/api/agents/agent-123",
    httpRoute: "/api/agents/:id",
    httpStatus: 200,
    requestId: "req-abc-123",
    sourceIp: "10.0.0.1",
    userAgent: "Mozilla/5.0",
    occurredAt: new Date("2026-05-13T10:00:00Z").toISOString(),
    createdAt: new Date("2026-05-13T10:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeEmptyPagination() {
  return {
    currentPage: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  };
}

function makePagination(total = 1) {
  return {
    currentPage: 1,
    limit: 10,
    total,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  };
}

function withRows(events: AuditLog[]) {
  return {
    data: { data: events, pagination: makePagination(events.length) },
    isFetching: false,
    refetch: vi.fn(),
  };
}

function withEmpty() {
  return {
    data: { data: [], pagination: makeEmptyPagination() },
    isFetching: false,
    refetch: vi.fn(),
  };
}

function withLoadError(refetch = vi.fn()) {
  return {
    data: undefined,
    isFetching: false,
    isLoadingError: true,
    refetch,
  };
}

function renderTable() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditLogTable />
    </QueryClientProvider>,
  );
}

describe("AuditLogTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/audit/logs");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    mockUseMemberSearch.mockReturnValue({
      users: [],
      isSearching: false,
      onSearchQueryChange: vi.fn(),
      emptyMessage: "No matching users found.",
    });
    mockUseProfilesPaginated.mockReturnValue({ data: { data: [] } });
    mockUseMcpServers.mockReturnValue({ data: [] });
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
    mockUseRolesPaginated.mockReturnValue({ data: { data: [] } });
    mockUseEnvironments.mockReturnValue({ data: { environments: [] } });
    mockUseApps.mockReturnValue({ data: { data: [] } });
    mockUseSkillsPaginated.mockReturnValue({ data: { data: [] } });
  });

  it("renders rows returned from the query with actor, action, outcome and resource", () => {
    mockUseAuditLogs.mockReturnValue(withRows([makeEvent()]));

    renderTable();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Agent updated")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Activity" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Where" })).toBeNull();
    expect(screen.queryByText("10.0.0.1")).toBeNull();
  });

  it("action column renders the human label, not the raw dotted name", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([makeEvent({ action: "agent.created" })]),
    );

    renderTable();

    expect(screen.getByText("Agent created")).toBeInTheDocument();
    expect(screen.queryByText("agent.created")).not.toBeInTheDocument();
  });

  it("renders restore actions with a specific label", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([makeEvent({ action: "agent.restored" })]),
    );

    renderTable();

    expect(screen.getByText("Agent restored")).toBeInTheDocument();
    expect(screen.queryByText("Unknown create")).not.toBeInTheDocument();
  });

  it("activity shows the correct result for each outcome", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([makeEvent({ outcome: "denied" })]),
    );

    renderTable();

    expect(screen.getByText("Denied")).toBeInTheDocument();
  });

  it("falls back to 'Deleted user' when the actor is null", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          actorId: null,
          actorName: null,
          actorEmail: null,
        }),
      ]),
    );

    renderTable();
    expect(screen.getByText("Deleted user")).toBeInTheDocument();
  });

  it("opens the detail dialog when a row is clicked", async () => {
    mockUseAuditLogs.mockReturnValue(withRows([makeEvent()]));

    renderTable();

    const row = screen.getByText("Ada Lovelace").closest("tr");
    expect(row).not.toBeNull();
    if (!row) throw new Error("expected table row");
    await userEvent.click(row);

    expect(
      await screen.findByRole("heading", { name: /Event details/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("/api/agents/agent-123")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
  });

  it("does not render the resource_id in the table — only the resource type", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          resourceType: "agent",
          resourceId: "very-distinctive-agent-id-12345",
        }),
      ]),
    );

    renderTable();

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(
      screen.queryByText("very-distinctive-agent-id-12345"),
    ).not.toBeInTheDocument();
  });

  it("renders the denormalized resource name next to the type badge", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({ resourceName: "Support Agent", before: null, after: null }),
      ]),
    );

    renderTable();

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Support Agent")).toBeInTheDocument();
  });

  it("shows a bare type chip, without the name, for types outside the picker set", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          resourceType: "apiKey",
          resourceName: "Distinctive Key Name",
          before: null,
          after: null,
        }),
      ]),
    );

    renderTable();

    expect(screen.getByText("API key")).toBeInTheDocument();
    expect(screen.queryByText("Distinctive Key Name")).not.toBeInTheDocument();
  });

  it("falls back to the snapshot name for rows written before resource_name existed", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          resourceName: null,
          before: { name: "Legacy Snapshot Agent" },
          after: null,
        }),
      ]),
    );

    renderTable();

    expect(screen.getByText("Legacy Snapshot Agent")).toBeInTheDocument();
  });

  it("reads resourceId filter from URL params and passes to useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("resourceId=agent-xyz") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "agent-xyz" }),
    );
  });

  it("requests both active and soft-deleted agents for the entity picker", () => {
    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseProfilesPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
    expect(mockUseProfilesPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );
  });

  it("entity picker lists non-agent entities and applies resourceId on pick", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    mockUseAuditLogs.mockReturnValue(withEmpty());
    mockUseMcpServers.mockReturnValue({
      data: [{ id: "mcp-1", name: "context7" }],
    });

    renderTable();

    // The resource picker is one of the secondary filters, so it is reached
    // through "More filters" until something is selected in it.
    await userEvent.click(screen.getByRole("button", { name: /More filters/ }));
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Filter by resource" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /context7/i }),
    );

    expect(push).toHaveBeenCalled();
    const url = String(push.mock.calls[push.mock.calls.length - 1][0]);
    expect(url).toContain("resourceId=mcp-1");
  });

  it("keeps an applied secondary filter on the bar rather than behind More filters", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("actorType=user") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    // Applied, so it is inline and readable without opening anything —
    // a filter narrowing the table from inside a closed popover would leave
    // the empty result unexplained.
    expect(
      screen.getByRole("combobox", { name: "Filter by actor type" }),
    ).toBeInTheDocument();
  });

  it("reads action and resource filters from URL params and passes to useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "action=agent.updated&resourceType=role&search=alice",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.updated",
        resourceType: "role",
        search: "alice",
        offset: 0,
        sortDirection: "desc",
      }),
    );
  });

  it("reads outcome filter from URL params and passes to useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("outcome=denied") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied" }),
    );
  });

  it("reads actorType filter from URL params and passes to useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("actorType=api_key") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "api_key" }),
    );
  });

  it("reads actorId filter from URL params and passes to useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("actorId=user-xyz") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "user-xyz" }),
    );
  });

  it("ignores an unknown outcome in the URL and passes undefined", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("outcome=unknown_value") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: undefined }),
    );
  });

  it("ALL_OUTCOMES covers success, failure, and denied", () => {
    expect(ALL_OUTCOMES).toContain("success");
    expect(ALL_OUTCOMES).toContain("failure");
    expect(ALL_OUTCOMES).toContain("denied");
    expect(ALL_OUTCOMES).toHaveLength(3);
  });

  it("ALL_ACTOR_TYPES covers user, api_key, service_account, sso, and system", () => {
    expect(ALL_ACTOR_TYPES).toContain("user");
    expect(ALL_ACTOR_TYPES).toContain("api_key");
    expect(ALL_ACTOR_TYPES).toContain("service_account");
    expect(ALL_ACTOR_TYPES).toContain("sso");
    expect(ALL_ACTOR_TYPES).toContain("system");
    expect(ALL_ACTOR_TYPES).toHaveLength(5);
  });

  it("renders the empty state when no rows and no filters are active", () => {
    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();
    expect(
      screen.getByText(/No audit events recorded yet/i),
    ).toBeInTheDocument();
  });

  it("shows a retry panel (not the empty state) when the query fails to load", async () => {
    const refetch = vi.fn();
    mockUseAuditLogs.mockReturnValue(withLoadError(refetch));

    renderTable();

    // A failed fetch must not be misread as "no events recorded".
    expect(
      screen.queryByText(/No audit events recorded yet/i),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps client network metadata out of the overview", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          sourceIp: "172.16.0.5",
          userAgent: null,
        }),
      ]),
    );

    renderTable();

    expect(screen.getByText("Time")).toBeInTheDocument();
    expect(screen.queryByText("Where")).toBeNull();
    expect(screen.queryByText("172.16.0.5")).toBeNull();
  });

  it("Clear filters resets URL search params via router.push", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "action=agent.updated&search=findme&outcome=denied",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );

    mockUseAuditLogs.mockReturnValue(withEmpty());

    renderTable();

    await userEvent.click(
      screen.getByRole("button", { name: /Clear filters/i }),
    );

    expect(push).toHaveBeenCalled();
    const url = String(push.mock.calls[push.mock.calls.length - 1][0]);
    expect(url).not.toContain("action=agent.updated");
    expect(url).not.toContain("search=findme");
    expect(url).not.toContain("outcome=denied");
  });
});
