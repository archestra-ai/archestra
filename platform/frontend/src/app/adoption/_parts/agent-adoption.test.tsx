import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdoptionMembersQuery,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { AgentAdoptionUsers } from "./agent-adoption";

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
// Picking a state scrolls to the users table; jsdom lacks scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

const mockUseAgentAdoptionMembers = vi.fn();
const mockReplace = vi.fn();
let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  usePathname: () => "/adoption",
  useSearchParams: () => mockSearch,
}));

vi.mock("@/lib/connected-client.query", () => ({
  useAgentAdoptionMembers: (query: AdoptionMembersQuery) =>
    mockUseAgentAdoptionMembers(query),
  useExportAgentAdoptionMembers: () => ({ mutate: vi.fn(), isPending: false }),
}));

const now = new Date().toISOString();

function member(overrides: Partial<AgentAdoptionMember>): AgentAdoptionMember {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "notConnected",
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
    agents: [],
    gatewayUses: [],
    llmUses: [],
    ...overrides,
  };
}

const members: AgentAdoptionMember[] = [
  member({ userId: "u-ada" }),
  member({
    userId: "u-alan",
    name: "Alan Turing",
    email: "alan@example.com",
    status: "inactive",
    gatewayLastSeenAt: "2026-01-01T00:00:00.000Z",
  }),
  member({
    userId: "u-grace",
    name: "Grace Hopper",
    email: "grace@example.com",
    status: "active",
    gatewayLastSeenAt: now,
    agents: [
      {
        clientId: "claude-code",
        name: "Claude Code",
        status: "active",
        setupAt: now,
        signedIn: false,
        viaToken: false,
        lastGatewayCallAt: now,
        lastLlmCallAt: null,
      },
      {
        clientId: null,
        name: "Unknown agent",
        status: "inactive",
        setupAt: null,
        signedIn: false,
        viaToken: true,
        lastGatewayCallAt: now,
        lastLlmCallAt: null,
      },
    ],
  }),
];

describe("AgentAdoptionUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = new URLSearchParams();
    mockUseAgentAdoptionMembers.mockReturnValue({
      data: {
        data: members,
        pagination: {
          currentPage: 1,
          limit: 25,
          total: members.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });
  });

  it("shows each user's state and last calls", () => {
    render(<AgentAdoptionUsers window={WINDOW} />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Ada Lovelace.*None.*Not connected.*Never/),
      expect.stringMatching(/Alan Turing.*Inactive/),
      expect.stringMatching(/Grace Hopper.*Active/),
    ]);
    for (const name of ["Last MCP tool call", "Last LLM proxy call"]) {
      expect(
        within(table).getByRole("columnheader", { name }),
      ).toBeInTheDocument();
    }
  });

  it("opens a user's agents with how each got there", () => {
    render(<AgentAdoptionUsers window={WINDOW} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Show Grace Hopper's agents" }),
    );

    expect(screen.getByText(/^Set up /)).toBeInTheDocument();
    expect(screen.getByText("Calls on a pasted token")).toBeInTheDocument();
  });

  it("asks the server for the URL's filters and the picked sort", () => {
    mockSearch = new URLSearchParams("state=inactive&q=alan");
    render(<AgentAdoptionUsers window={WINDOW} />);

    expect(mockUseAgentAdoptionMembers).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startDate: WINDOW.startDate,
        state: "inactive",
        search: "alan",
        sortBy: "state",
        sortDirection: "asc",
        offset: 0,
      }),
    );

    // A last call sorts newest first, and back on a second click.
    const header = () =>
      screen.getByRole("button", { name: /Last MCP tool call/ });
    fireEvent.click(header());
    expect(mockUseAgentAdoptionMembers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "gateway", sortDirection: "desc" }),
    );
    fireEvent.click(header());
    expect(mockUseAgentAdoptionMembers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "gateway", sortDirection: "asc" }),
    );
  });
});
