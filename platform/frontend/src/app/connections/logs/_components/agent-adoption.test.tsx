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
    agents: [],
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
    skillLastUsedAt: null,
    ...overrides,
  };
}

const now = new Date().toISOString();

function agent(
  overrides: Partial<AgentAdoptionMember["agents"][number]>,
): AgentAdoptionMember["agents"][number] {
  return {
    clientId: null,
    name: "Agent",
    setUpAt: null,
    signedInAt: null,
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
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
      gatewayLastSeenAt: new Date().toISOString(),
      agents: [
        agent({ clientId: "claude-code", name: "Claude Code", setUpAt: now }),
        agent({ clientId: null, name: "Droid", gatewayLastSeenAt: now }),
        agent({ clientId: null, name: "Unknown agent", llmLastSeenAt: now }),
      ],
    }),
    member({
      userId: "u-alan",
      name: "Alan Turing",
      email: "alan@example.com",
      status: "setUp",
      agents: [
        agent({ clientId: "claude-code", name: "Claude Code", setUpAt: now }),
        agent({ clientId: "codex", name: "Codex", setUpAt: now }),
      ],
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
  it("counts members per agent by name, with a Not connected row", () => {
    expect(agentChartData(adoption)).toEqual([
      { id: "claude-code", label: "Claude Code", members: 2 },
      { id: "codex", label: "Codex", members: 1 },
      { id: "droid", label: "Droid", members: 1 },
      { id: "name:unknown agent", label: "Unknown agent", members: 1 },
      { id: "none", label: "Not connected", members: 1 },
    ]);
  });
});
