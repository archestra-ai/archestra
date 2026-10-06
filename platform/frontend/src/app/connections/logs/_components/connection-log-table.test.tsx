import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionLogEntry,
  ConnectionLogPage,
} from "@/lib/connected-client.query";
import { ConnectionLogTable } from "./connection-log-table";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mockUseConnectionLog = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/connected-client.query", () => ({
  useConnectionLog: (...args: unknown[]) => mockUseConnectionLog(...args),
}));

function entry(overrides: Partial<ConnectionLogEntry>): ConnectionLogEntry {
  return {
    id: "setup-1",
    connectedAt: "2026-10-01T09:00:00.000Z",
    userId: "user-1",
    userName: "Ada Lovelace",
    userEmail: "ada@example.com",
    clientId: "claude-code",
    platform: "macos",
    deviceName: "work-laptop",
    mcpGateway: null,
    modelRouting: false,
    includeSkills: false,
    disconnectedAt: null,
    ...overrides,
  };
}

function page(rows: ConnectionLogEntry[]): ConnectionLogPage {
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
      <ConnectionLogTable />
    </QueryClientProvider>,
  );
}

describe("ConnectionLogTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/connections/logs");
  });

  it("shows who connected which agent, where, to what and when", () => {
    mockUseConnectionLog.mockReturnValue({
      data: page([
        entry({
          mcpGateway: { id: "gw-1", name: "Engineering tools" },
          modelRouting: true,
        }),
        entry({
          id: "setup-2",
          clientId: "codex",
          userName: "Grace Hopper",
          deviceName: null,
          platform: "windows",
          disconnectedAt: "2026-10-02T09:00:00.000Z",
        }),
      ]),
      isPending: false,
      isFetching: false,
    });

    renderTable();

    const [, ada, grace] = screen.getAllByRole("row");
    expect(within(ada).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(ada).getByText("Claude Code")).toBeInTheDocument();
    expect(within(ada).getByText("work-laptop")).toBeInTheDocument();
    expect(
      within(ada).getByText("Tools: Engineering tools"),
    ).toBeInTheDocument();
    expect(within(ada).getByText("Model routing")).toBeInTheDocument();
    expect(within(ada).queryByText("Disconnected")).not.toBeInTheDocument();
    expect(within(grace).getByText("Codex")).toBeInTheDocument();
    expect(within(grace).getByText("Unknown device")).toBeInTheDocument();
    expect(within(grace).getByText("Windows")).toBeInTheDocument();
    expect(within(grace).getByText("Disconnected")).toBeInTheDocument();
  });

  it("asks for the page, search and agent in the URL", () => {
    mockUseConnectionLog.mockReturnValue({
      data: page([]),
      isPending: false,
      isFetching: false,
    });

    renderTable("page=3&limit=20&search=ada&agent=cursor");

    expect(mockUseConnectionLog).toHaveBeenCalledWith({
      limit: 20,
      offset: 40,
      search: "ada",
      clientId: "cursor",
    });
  });
});
