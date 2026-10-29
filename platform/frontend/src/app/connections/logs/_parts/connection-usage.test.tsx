import { fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdoption,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { ConnectionUsageExplorer } from "./connection-usage";
import {
  amount,
  factsOf,
  filterFacts,
  groupsOf,
} from "./connection-usage-data";

/** The page's URL: the explorer keeps its drilldown there. */
const location = {
  search: new URLSearchParams(),
  listeners: new Set<() => void>(),
  push(href: string) {
    location.search = new URLSearchParams(href.split("?")[1] ?? "");
    for (const listener of location.listeners) listener();
  },
};
vi.mock("next/navigation", () => ({
  usePathname: () => "/connections/logs",
  useRouter: () => ({ push: location.push, replace: location.push }),
  useSearchParams: () =>
    useSyncExternalStore(
      (listener) => {
        location.listeners.add(listener);
        return () => location.listeners.delete(listener);
      },
      () => location.search,
    ),
}));

const window = {
  startDate: "2026-10-01T00:00:00Z",
  label: "last 30 days",
  picked: false,
};
const latest = "2026-10-16T14:00:00Z";
function member(overrides: Partial<AgentAdoptionMember>): AgentAdoptionMember {
  return {
    userId: "user-a",
    name: "Member Alpha",
    email: "alpha@example.com",
    status: "active",
    gatewayLastSeenAt: latest,
    llmLastSeenAt: latest,
    agents: [],
    gatewayUses: [],
    llmUses: [],
    ...overrides,
  };
}
const adoption: AgentAdoption = {
  since: window.startDate,
  until: latest,
  members: [
    member({
      gatewayUses: [
        {
          agent: { clientId: "install-a", name: "Claude Code" },
          via: { id: "shared", name: "Development" },
          calls: 10,
          lastSeenAt: "2026-10-16T12:00:00Z",
        },
        {
          agent: { clientId: "install-a", name: "Claude Code" },
          via: { id: "other", name: "Research" },
          calls: 2,
          lastSeenAt: latest,
        },
      ],
      llmUses: [
        {
          agent: { clientId: "install-a", name: "Claude Code" },
          via: { id: "shared", name: "Development" },
          calls: 3,
          lastSeenAt: latest,
        },
      ],
    }),
    member({
      userId: "user-b",
      name: "Member Beta",
      email: "beta@example.com",
      gatewayUses: [
        {
          agent: { clientId: "install-b", name: "Claude Code" },
          via: { id: "shared", name: "Development" },
          calls: 7,
          lastSeenAt: "2026-10-16T13:00:00Z",
        },
      ],
    }),
    member({
      userId: "user-c",
      name: "Member Gamma",
      email: "gamma@example.com",
      status: "notConnected",
      gatewayLastSeenAt: null,
      llmLastSeenAt: null,
    }),
  ],
};

function grouped(dimension: "user" | "agent" | "service") {
  return groupsOf({
    facts: factsOf(adoption),
    dimension,
    members: adoption.members,
    scope: {},
  });
}

describe("connection usage", () => {
  beforeEach(() => {
    location.search = new URLSearchParams();
  });
  it("groups one agent across installations without multiplying calls or users", () => {
    const [agent] = grouped("agent");
    expect(agent).toMatchObject({
      label: "Claude Code",
      calls: 22,
      mcp: 19,
      llm: 3,
      users: 2,
      agents: 1,
      lastSeenAt: latest,
    });
    expect(grouped("agent")).toHaveLength(1);
  });
  it("keeps gateways and proxies with the same id separate", () => {
    const services = grouped("service");
    expect(services).toHaveLength(3);
    expect(services.find((row) => row.key === "mcp:shared")?.calls).toBe(17);
    expect(services.find((row) => row.key === "llm:shared")?.calls).toBe(3);
  });
  it("intersects drilldown scope, metric, and search", () => {
    const facts = factsOf(adoption);
    const selected = filterFacts({
      facts,
      scope: { user: "user-a", service: "mcp:shared" },
      metric: "mcp",
      search: " ALPHA ",
    });
    expect(amount(selected)).toBe(10);
    expect(
      filterFacts({ facts, scope: { user: "user-b", service: "llm:shared" } }),
    ).toEqual([]);
    expect(
      filterFacts({ facts, scope: {}, metric: "llm", search: "Research" }),
    ).toEqual([]);
  });
  it("keeps zero-call users at the root and excludes them from a scoped path", () => {
    expect(grouped("user").map((row) => [row.key, row.calls])).toEqual([
      ["user-a", 15],
      ["user-b", 7],
      ["user-c", 0],
    ]);
    const facts = filterFacts({
      facts: factsOf(adoption),
      scope: { service: "mcp:shared" },
    });
    expect(
      groupsOf({
        facts,
        dimension: "user",
        members: adoption.members,
        scope: { service: "mcp:shared" },
      }).map((row) => row.key),
    ).toEqual(["user-a", "user-b"]);
    expect(
      groupsOf({
        facts: [],
        dimension: "user",
        members: adoption.members,
        scope: {},
        search: "gamma",
      }),
    ).toMatchObject([{ key: "user-c", calls: 0, lastSeenAt: null }]);
  });
  it("drills from user to agent to service, then steps back out", () => {
    render(<ConnectionUsageExplorer adoption={adoption} window={window} />);
    openRow("Member Alpha");
    expect(location.search.get("user")).toBe("user-a");
    expect(
      within(screen.getByRole("table")).queryByText("Member Beta"),
    ).not.toBeInTheDocument();
    openRow("Claude Code");
    expect(
      screen.getByRole("button", { name: "Remove Claude Code filter" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getAllByText("Development"),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.queryByRole("button", { name: "Remove Claude Code filter" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Claude Code: 15 calls" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(location.search.toString()).toBe("");
    expect(
      screen.getByRole("button", { name: "Member Beta: 7 calls" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
  });
  it("regroups by a filter when it is removed, keeping the others", () => {
    render(<ConnectionUsageExplorer adoption={adoption} window={window} />);
    openRow("Member Alpha");
    openRow("Claude Code");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Member Alpha filter" }),
    );
    // Every user of Claude Code, not Claude Code's gateways for nobody.
    expect(
      screen.getByRole("button", { name: "Member Alpha: 15 calls" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Member Beta: 7 calls" }),
    ).toBeInTheDocument();
  });
  it("opens a shared drilldown link where it was left", () => {
    location.search = new URLSearchParams("by=agent&user=user-b");
    render(<ConnectionUsageExplorer adoption={adoption} window={window} />);
    expect(
      screen.getByRole("button", { name: "Remove Member Beta filter" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Claude Code: 7 calls" }),
    ).toBeInTheDocument();
  });
  it("narrows by a call-type count and resets to all connections", () => {
    render(<ConnectionUsageExplorer adoption={adoption} window={window} />);
    const row = within(screen.getByRole("table"))
      .getByText("Member Alpha")
      .closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "12" }));
    expect(
      screen.getByRole("button", { name: "Remove MCP filter" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Member Alpha filter" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All connections" }));
    expect(
      screen.queryByRole("button", { name: /^Remove/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Member Beta: 7 calls" }),
    ).toBeInTheDocument();
  });
});

function openRow(name: string) {
  fireEvent.click(
    within(screen.getByRole("table"))
      .getByText(name)
      .closest("tr") as HTMLElement,
  );
}
