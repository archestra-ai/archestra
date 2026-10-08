import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdoption,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { AgentAdoptionOverview } from "./agent-adoption";

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

const mockUseAgentAdoption = vi.fn();
const mockReplace = vi.fn();
let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  usePathname: () => "/connections/logs",
  useSearchParams: () => mockSearch,
}));

vi.mock("@/lib/connected-client.query", () => ({
  useAgentAdoption: () => mockUseAgentAdoption(),
  useAgentAdoptionUsage: () => ({
    data: {
      since: now,
      until: now,
      days: [
        { date: "2026-10-06", gatewayCalls: 10, llmCalls: 5 },
        { date: "2026-10-07", gatewayCalls: 20, llmCalls: 15 },
      ],
    },
    isPending: false,
    isLoadingError: false,
  }),
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

const adoption: AgentAdoption = {
  since: "2026-09-07T00:00:00.000Z",
  until: "2026-10-07T00:00:00.000Z",
  members: [
    member({ userId: "u-ada" }),
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
    member({
      userId: "u-alan",
      name: "Alan Turing",
      email: "alan@example.com",
      status: "inactive",
      gatewayLastSeenAt: "2026-01-01T00:00:00.000Z",
    }),
  ],
};

describe("AgentAdoptionOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = new URLSearchParams();
    mockUseAgentAdoption.mockReturnValue({
      data: adoption,
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });
  });

  it("lists users without an agent first, then inactive, then active", () => {
    render(<AgentAdoptionOverview window={WINDOW} />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Not connected.*Ada Lovelace.*None.*Never/),
      expect.stringMatching(/Inactive.*Alan Turing/),
      expect.stringMatching(/Active.*Grace Hopper/),
    ]);
    for (const name of ["Last MCP tool call", "Last LLM proxy call"]) {
      expect(
        within(table).getByRole("columnheader", { name }),
      ).toBeInTheDocument();
    }
  });

  it("opens a user's agents with how each got there", () => {
    render(<AgentAdoptionOverview window={WINDOW} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Show Grace Hopper's agents" }),
    );

    expect(screen.getByText(/^Set up /)).toBeInTheDocument();
    expect(screen.getByText("Calls on a pasted token")).toBeInTheDocument();
  });

  it("filters the table by state from the URL", () => {
    mockSearch = new URLSearchParams("state=inactive");
    render(<AgentAdoptionOverview window={WINDOW} />);

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("Alan Turing");
  });

  it("puts a state picked on the donut in the URL", () => {
    render(<AgentAdoptionOverview window={WINDOW} />);

    fireEvent.click(screen.getByRole("button", { name: /^Active\s*1/ }));

    expect(mockReplace).toHaveBeenCalledWith("/connections/logs?state=active", {
      scroll: false,
    });
  });

  it("shows adoption, agents in use and agent calls on top", () => {
    render(<AgentAdoptionOverview window={WINDOW} />);

    expect(
      screen.getByRole("img", {
        name: "Active: 1, Inactive: 1, Not connected: 1",
      }),
    ).toBeInTheDocument();
    // Only active agents count, and the pasted-token one is not named.
    const inUse = screen
      .getByText(/^Most used agents/)
      .closest("[data-slot=card]");
    expect(inUse).toHaveTextContent("Claude Code1");
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(
      screen.getByText("30 tool calls · 20 LLM calls"),
    ).toBeInTheDocument();
  });
});
