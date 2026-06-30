import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { ALL_ACTOR_TYPES, ALL_OUTCOMES } from "./audit-log-action-labels";
import { AuditLogTable } from "./audit-log-table";

/**
 * Contract: AuditLogTable — columns (When / Actor / Action / Outcome / Resource / Where),
 * resource id hidden in grid, detail dialog on row click, URL-driven filters + clear resets page.
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
const mockUseMembersPaginated = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

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
  useMembersPaginated: (...args: unknown[]) => mockUseMembersPaginated(...args),
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
    action: "agent.updated",
    outcome: "success",
    resourceType: "agent",
    resourceId: "agent-123",
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
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/audit/logs");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    mockUseMembersPaginated.mockReturnValue({ data: { data: [] } });
  });

  it("renders rows returned from the query with actor, action, outcome and resource", () => {
    mockUseAuditLogs.mockReturnValue(withRows([makeEvent()]));

    renderTable();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Agent updated")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
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

  it("outcome column renders the correct badge text for each outcome", () => {
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
  });

  it("does not render the resource_id in the table — only the resource-type badge", () => {
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

  it("renders When / Where headers and surfaces the client IP in the grid", () => {
    mockUseAuditLogs.mockReturnValue(
      withRows([
        makeEvent({
          sourceIp: "172.16.0.5",
          userAgent: null,
        }),
      ]),
    );

    renderTable();

    expect(screen.getByText("When")).toBeInTheDocument();
    expect(screen.getByText("Where")).toBeInTheDocument();
    expect(screen.getByText("172.16.0.5")).toBeInTheDocument();
  });

  it("Clear filters resets URL search params via router.push", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
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
