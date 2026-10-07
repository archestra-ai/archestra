import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdoption,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
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
    status: "inactive",
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
    gatewayUses: [],
    llmUses: [],
    skillSyncs: [],
    ...overrides,
  };
}

const now = new Date().toISOString();

const adoption: AgentAdoption = {
  lookbackDays: 30,
  members: [
    member({ userId: "u-ada" }),
    member({
      userId: "u-grace",
      name: "Grace Hopper",
      email: "grace@example.com",
      status: "active",
      gatewayLastSeenAt: now,
      llmLastSeenAt: now,
      gatewayUses: [
        {
          via: { id: "gw-1", name: "Engineering tools" },
          agent: { clientId: null, name: "Droid" },
          calls: 12,
          lastSeenAt: now,
        },
      ],
      llmUses: [
        {
          via: { id: null, name: "LLM proxy" },
          agent: { clientId: "generic", name: "Generic client" },
          calls: 3,
          lastSeenAt: now,
        },
      ],
    }),
    member({
      userId: "u-alan",
      name: "Alan Turing",
      email: "alan@example.com",
      status: "inactive",
      skillSyncs: [
        { agent: { clientId: "codex", name: "Codex" }, lastSyncedAt: now },
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

  it("lists all members by name, without a Skills column", () => {
    render(<AgentAdoptionOverview />);

    const table = screen.getAllByRole("table")[0];
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ada Lovelace"),
      expect.stringContaining("Alan Turing"),
      expect.stringContaining("Grace Hopper"),
    ]);
    expect(
      within(table).getByRole("columnheader", { name: "Skills synced" }),
    ).toBeInTheDocument();
    // A skills sync alone doesn't make a member active.
    const alan = within(table).getByText("Alan Turing").closest("tr");
    expect(alan).toHaveTextContent(formatRelativeTimeFromNow(now));
    expect(alan).toHaveTextContent("No calls in 30 days");
  });

  it("notes quiet members and opens a member's calls on click", () => {
    render(<AgentAdoptionOverview />);

    const table = screen.getAllByRole("table")[0];
    const alan = within(table).getByText("Alan Turing").closest("tr");
    expect(alan).toHaveTextContent("No calls in 30 days");

    const grace = within(table).getByText("Grace Hopper").closest("tr");
    fireEvent.click(grace as HTMLElement);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Droid")).toBeInTheDocument();
    expect(within(dialog).getByText("Engineering tools")).toBeInTheDocument();
    expect(within(dialog).getByText("12")).toBeInTheDocument();
  });

  it("counts gateway and LLM proxy use in the tiles", () => {
    render(<AgentAdoptionOverview />);

    const tile = (label: string) =>
      screen
        .getByText(label, { exact: false })
        .closest("[data-slot=card]") as HTMLElement;
    expect(tile("Members using MCP gateway")).toHaveTextContent("1of 3 · 33%");
    expect(tile("Members using LLM proxy")).toHaveTextContent("1of 3 · 33%");
    expect(tile("Active members")).toHaveTextContent("1of 3 · 33%");
  });
});

describe("agentChartData", () => {
  it("counts members per agent by name, with an Inactive row", () => {
    expect(agentChartData(adoption)).toEqual([
      { id: "droid", label: "Droid", members: 1 },
      { id: "generic", label: "Generic client", members: 1 },
      { id: "inactive", label: "Inactive", members: 2 },
    ]);
  });
});
