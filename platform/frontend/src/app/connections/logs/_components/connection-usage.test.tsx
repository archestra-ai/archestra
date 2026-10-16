import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("drills from user to agent to service and removes a scope filter", () => {
    render(
      <ConnectionUsageExplorer
        adoption={adoption}
        window={window}
        initialGroup="user"
      />,
    );
    fireEvent.click(
      within(screen.getByRole("table"))
        .getByText("Member Alpha")
        .closest("tr") as HTMLElement,
    );
    expect(
      screen.getByRole("button", { name: "Remove Member Alpha filter" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).queryByText("Member Beta"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("table"))
        .getByText("Claude Code")
        .closest("tr") as HTMLElement,
    );
    expect(
      screen.getByRole("button", { name: "Remove Claude Code filter" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getAllByText("Development"),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Member Alpha filter" }),
    );
    expect(
      screen.queryByRole("button", { name: "Remove Member Alpha filter" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Development (MCP gateway): 17 calls",
      }),
    ).toBeInTheDocument();
  });
  it("narrows by a call-type count and resets to all connections", () => {
    render(
      <ConnectionUsageExplorer
        adoption={adoption}
        window={window}
        initialGroup="user"
      />,
    );
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
      screen.getByRole("button", { name: "Claude Code: 22 calls" }),
    ).toBeInTheDocument();
  });
});
