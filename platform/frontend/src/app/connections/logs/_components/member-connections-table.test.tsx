import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemberConnections,
  MemberConnectionsPage,
} from "@/lib/connected-client.query";
import { MemberConnectionsTable } from "./member-connections-table";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mockUseMemberConnections = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/connected-client.query", () => ({
  useMemberConnections: (...args: unknown[]) =>
    mockUseMemberConnections(...args),
}));

function member(overrides: Partial<MemberConnections>): MemberConnections {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    image: null,
    lastConnectedAt: null,
    clients: [],
    ...overrides,
  };
}

function page(rows: MemberConnections[]): MemberConnectionsPage {
  return {
    data: rows,
    pagination: {
      currentPage: 1,
      limit: 10,
      total: rows.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
    summary: { memberCount: 40, connectedCount: 12 },
  };
}

function renderTable(search = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(search) as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemberConnectionsTable />
    </QueryClientProvider>,
  );
}

describe("MemberConnectionsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/connections/logs");
  });

  it("shows who connected which agent and who never did", () => {
    const connectedAt = "2026-10-01T09:00:00.000Z";
    mockUseMemberConnections.mockReturnValue({
      data: page([
        member({
          userId: "ada",
          lastConnectedAt: connectedAt,
          clients: [
            {
              clientId: "claude-code",
              connectedAt,
              lastConnectedAt: connectedAt,
              deviceNames: ["work-laptop"],
            },
          ],
        }),
        member({ userId: "grace", name: "Grace Hopper" }),
      ]),
      isPending: false,
      isFetching: false,
    });

    renderTable();

    expect(
      screen.getByText("12 of 40 members have connected an agent."),
    ).toBeInTheDocument();
    const [, adaRow, graceRow] = screen.getAllByRole("row");
    expect(within(adaRow).getByText("Claude Code")).toBeInTheDocument();
    expect(within(adaRow).getByText("work-laptop")).toBeInTheDocument();
    expect(within(adaRow).getByText("Oct 1, 2026")).toBeInTheDocument();
    expect(within(graceRow).getByText("Not connected")).toBeInTheDocument();
    expect(within(graceRow).getByText("Never")).toBeInTheDocument();
  });

  it("asks for the page, search and status in the URL", () => {
    mockUseMemberConnections.mockReturnValue({
      data: page([]),
      isPending: false,
      isFetching: false,
    });

    renderTable("page=3&limit=20&name=ada&status=not_connected");

    expect(mockUseMemberConnections).toHaveBeenCalledWith({
      limit: 20,
      offset: 40,
      name: "ada",
      status: "not_connected",
    });
  });
});
