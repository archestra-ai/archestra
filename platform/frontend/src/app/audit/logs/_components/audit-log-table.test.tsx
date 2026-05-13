import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { AuditLogTable } from "./audit-log-table";

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
  const actual =
    await vi.importActual<typeof import("@/lib/audit-log/audit-log.query")>(
      "@/lib/audit-log/audit-log.query",
    );
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
    await userEvent.click(row!);

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
});
