import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { AuditLogTable } from "./audit-log-table";

/**
 * Contract: AuditLogTable — columns (When / Actor / Action / Resource / Where),
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
const mockUseAuditLogWebsocket = vi.fn();
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

vi.mock("@/lib/audit-log/audit-log-websocket.hook", () => ({
  useAuditLogWebsocket: (...args: unknown[]) =>
    mockUseAuditLogWebsocket(...args),
}));

vi.mock("@/lib/member.query", () => ({
  useMembersPaginated: (...args: unknown[]) => mockUseMembersPaginated(...args),
}));

function makeEvent(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "evt-1",
    organizationId: "org-1",
    actorUserId: "user-1",
    actorName: "Ada Lovelace",
    actorEmail: "ada@example.com",
    action: "update",
    resourceType: "agent",
    resourceId: "agent-123",
    priorState: { name: "Old name" },
    postState: { name: "New name" },
    httpMethod: "PATCH",
    httpPath: "/api/agents/agent-123",
    httpRoute: "/api/agents/:id",
    httpStatus: 200,
    ipAddress: "10.0.0.1",
    userAgent: "Mozilla/5.0",
    createdAt: new Date("2026-05-13T10:00:00Z").toISOString(),
    ...overrides,
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
    mockUseAuditLogWebsocket.mockReturnValue({
      newEventCount: 0,
      resetNewEventCount: vi.fn(),
    });
    mockUseMembersPaginated.mockReturnValue({ data: { data: [] } });
  });

  it("renders rows returned from the query with action, actor and resource", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [makeEvent()],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Update")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("falls back to 'Deleted user' when the actor user is null", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [
          makeEvent({
            actorUserId: null,
            actorName: null,
            actorEmail: null,
          }),
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();
    expect(screen.getByText("Deleted user")).toBeInTheDocument();
  });

  it("opens the detail dialog when a row is clicked", async () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [makeEvent()],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

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

  it("renders the 'new events' indicator when websocket reports unseen rows", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [makeEvent()],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });
    mockUseAuditLogWebsocket.mockReturnValue({
      newEventCount: 3,
      resetNewEventCount: vi.fn(),
    });

    renderTable();
    expect(
      screen.getByRole("button", { name: /3 new events — refresh/i }),
    ).toBeInTheDocument();
  });

  it("does not render the resource_id in the table — only the resource-type badge", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [
          makeEvent({
            resourceType: "agent",
            resourceId: "very-distinctive-agent-id-12345",
          }),
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();

    // Resource-type label should appear
    expect(screen.getByText("Agent")).toBeInTheDocument();
    // The id must NOT leak into the table; it only belongs in the detail dialog.
    expect(
      screen.queryByText("very-distinctive-agent-id-12345"),
    ).not.toBeInTheDocument();
  });

  it("passes the latest filter values into useAuditLogs", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "action=update&resourceType=role&search=alice",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );

    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();

    expect(mockUseAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        resourceType: "role",
        search: "alice",
        offset: 0,
        sortDirection: "desc",
      }),
    );
  });

  it("renders the empty state when no rows and no filters are active", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();
    expect(
      screen.getByText(/No audit events recorded yet/i),
    ).toBeInTheDocument();
  });

  it("renders When / Where headers and surfaces the client IP in the grid", () => {
    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [
          makeEvent({
            ipAddress: "172.16.0.5",
            userAgent: null,
          }),
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

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
        "action=update&search=findme",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );

    mockUseAuditLogs.mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isFetching: false,
      refetch: vi.fn(),
    });

    renderTable();

    await userEvent.click(
      screen.getByRole("button", { name: /Clear filters/i }),
    );

    expect(push).toHaveBeenCalled();
    const url = String(push.mock.calls[0][0]);
    expect(url).not.toContain("action=update");
    expect(url).not.toContain("search=findme");
  });
});
