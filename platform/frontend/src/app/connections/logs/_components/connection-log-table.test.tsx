import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionEvent,
  ConnectionLogPage,
} from "@/lib/connected-client.query";
import { ConnectionLogTable } from "./connection-log-table";

const WINDOW = {
  startDate: "2026-09-07T00:00:00.000Z",
  label: "last 30 days",
  picked: false,
};

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
vi.mock("@/lib/member.query", () => ({
  useMemberSearch: () => ({
    users: [],
    isSearching: false,
    onSearchQueryChange: vi.fn(),
    emptyMessage: "No matching users found.",
  }),
}));

function event(overrides: Partial<ConnectionEvent>): ConnectionEvent {
  return {
    id: "c:setup-1",
    action: "connected",
    occurredAt: "2026-10-01T09:00:00.000Z",
    userId: "user-1",
    userName: "Ada Lovelace",
    userEmail: "ada@example.com",
    clientId: "claude-code",
    agentName: "Claude Code",
    via: "setup",
    platform: "macos",
    deviceName: "work-laptop",
    mcpGateway: null,
    llmProxy: null,
    includeSkills: false,
    skillCount: 0,
    disconnectedBy: null,
    ...overrides,
  };
}

function page(rows: ConnectionEvent[]): ConnectionLogPage {
  return {
    data: rows,
    pagination: { limit: 10, nextCursor: null, hasNext: false },
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
      <ConnectionLogTable window={WINDOW} />
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

  it("shows each connect and disconnect as its own event", () => {
    mockUseConnectionLog.mockReturnValue({
      data: page([
        event({
          id: "d:setup-2",
          action: "disconnected",
          clientId: "codex",
          userName: "Grace Hopper",
          platform: null,
          deviceName: null,
          disconnectedBy: { id: "admin-1", name: "Admin" },
        }),
        event({
          mcpGateway: { id: "gw-1", name: "Engineering tools" },
          llmProxy: { id: "proxy-1", name: "Default" },
        }),
      ]),
      isFetching: false,
    });

    renderTable();

    const [, disconnect, connect] = screen.getAllByRole("row");
    expect(within(disconnect).getByText("Disconnect")).toBeInTheDocument();
    expect(disconnect).toHaveTextContent("by Admin");
    expect(within(disconnect).getByText("Codex")).toBeInTheDocument();
    expect(within(connect).getByText("Connect")).toBeInTheDocument();
    expect(within(connect).getByText("Claude Code")).toBeInTheDocument();
    expect(
      within(connect).getByText("work-laptop · macOS"),
    ).toBeInTheDocument();
    expect(within(connect).getByText("MCP gateway")).toBeInTheDocument();
    expect(within(connect).getByText("LLM proxy")).toBeInTheDocument();
    // A disconnect adds nothing.
    expect(within(disconnect).getByText("—")).toBeInTheDocument();
  });

  it("asks for the user and action in the URL", () => {
    mockUseConnectionLog.mockReturnValue({
      data: page([]),
      isFetching: false,
    });

    renderTable("userId=user-1&action=disconnected");

    expect(mockUseConnectionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "disconnected",
      }),
    );
  });
});
