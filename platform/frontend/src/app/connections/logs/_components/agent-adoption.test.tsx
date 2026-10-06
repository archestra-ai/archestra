import { render, screen, within } from "@testing-library/react";
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
  useAgentAdoptionUsage: () => ({
    data: { lookbackDays: 30, days: [] },
    isPending: false,
    isLoadingError: false,
  }),
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

    expect(
      screen.getByText("Not connected", {
        selector: "[data-slot=card-description]",
      }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("counts gateway and LLM proxy use in the tiles", () => {
    render(<AgentAdoptionOverview />);

    const tile = (label: string) =>
      screen.getByText(label).closest("[data-slot=card]") as HTMLElement;
    expect(tile("Used the MCP gateway")).toHaveTextContent("1of 3 · 33%");
    expect(tile("Used the LLM proxy")).toHaveTextContent("0of 3 · 0%");
    expect(tile("Connected")).toHaveTextContent("2of 3 · 67%");
  });
});

describe("agentChartData", () => {
  it("counts members per agent, with Other and Not connected rows", () => {
    expect(agentChartData(adoption)).toEqual([
      { id: "claude-code", label: "Claude Code", members: 2 },
      { id: "codex", label: "Codex", members: 1 },
      { id: "other", label: "Other", members: 1 },
      { id: "none", label: "Not connected", members: 1 },
    ]);
  });
});
