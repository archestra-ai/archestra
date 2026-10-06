import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdoption,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { AgentAdoptionOverview, agentChartData } from "./agent-adoption";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mockUseAgentAdoption = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections/logs",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/connected-client.query", () => ({
  useAgentAdoption: () => mockUseAgentAdoption(),
}));

function member(overrides: Partial<AgentAdoptionMember>): AgentAdoptionMember {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "notConnected",
    setUpAgents: [],
    lastSetUpAt: null,
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
    llmAgents: [],
    skillLastUsedAt: null,
    ...overrides,
  };
}

const adoption: AgentAdoption = {
  activeDays: 7,
  lookbackDays: 30,
  members: [
    member({ userId: "u-ada" }),
    member({
      userId: "u-grace",
      name: "Grace Hopper",
      email: "grace@example.com",
      status: "active",
      setUpAgents: ["claude-code"],
      gatewayLastSeenAt: new Date().toISOString(),
      llmAgents: ["anthropic_claude_code", "some_other_agent"],
    }),
    member({
      userId: "u-alan",
      name: "Alan Turing",
      email: "alan@example.com",
      status: "setUp",
      setUpAgents: ["codex", "claude-code"],
    }),
  ],
};

describe("AgentAdoptionOverview", () => {
  beforeEach(() => {
    mockUseAgentAdoption.mockReturnValue({
      data: adoption,
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });
  });

  it("leads with who hasn't connected and lists only them", () => {
    render(<AgentAdoptionOverview />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "1 of 3 members haven't connected an agent",
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("switches the list by status and back to everyone", () => {
    render(<AgentAdoptionOverview />);

    fireEvent.click(screen.getByRole("button", { name: /^Active/ }));
    let rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Grace Hopper")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ada Lovelace"),
      expect.stringContaining("Alan Turing"),
      expect.stringContaining("Grace Hopper"),
    ]);
  });
});

describe("agentChartData", () => {
  it("counts members per agent, folding unknown LLM agents into Other", () => {
    expect(agentChartData(adoption)).toEqual([
      { id: "claude-code", label: "Claude Code", setUp: 2, llm: 1 },
      { id: "codex", label: "Codex", setUp: 1, llm: 0 },
      { id: "other", label: "Other", setUp: 0, llm: 1 },
    ]);
  });
});
