import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedClient } from "@/lib/connected-client.query";
import type { ConnectPageData } from "./connect-page-data";
import { ManageAgents, useConnectedAgents } from "./connected-agents";

const mockUseConnectedClients = vi.fn();
const mockDisconnect = vi.fn();

vi.mock("@/lib/connected-client.query", () => ({
  useConnectedClients: () => mockUseConnectedClients(),
  useDisconnectConnectedClient: () => ({
    mutate: mockDisconnect,
    isPending: false,
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

function record(overrides: Partial<ConnectedClient>): ConnectedClient {
  return {
    clientId: "claude-code",
    lastConnectedAt: daysAgo(1),
    deviceNames: [],
    lastSeenAt: null,
    ...overrides,
  };
}

const data = {
  appName: "Acme",
  baseUrl: "http://localhost:3000/v1",
  footprintFor: () => ({ skillsInstalled: 0 }),
} as unknown as ConnectPageData;

describe("useConnectedAgents", () => {
  it("marks the newest connect that has traffic, not a silent setup", () => {
    mockUseConnectedClients.mockReturnValue({
      data: [
        // Newest, but never seen: the setup may have failed.
        record({ clientId: "codex", lastConnectedAt: daysAgo(0) }),
        record({ clientId: "claude-code", lastSeenAt: daysAgo(0) }),
        record({
          clientId: "cursor",
          lastConnectedAt: daysAgo(5),
          lastSeenAt: daysAgo(1),
        }),
      ],
    });

    const { result } = renderHook(() => useConnectedAgents());

    expect(result.current.agents.map((a) => a.clientId)).toEqual([
      "codex",
      "claude-code",
      "cursor",
    ]);
    expect(result.current.lastConnected?.clientId).toBe("claude-code");
  });

  it("marks nothing when no agent was ever seen", () => {
    mockUseConnectedClients.mockReturnValue({ data: [record({})] });

    const { result } = renderHook(() => useConnectedAgents());

    expect(result.current.lastConnected).toBeNull();
  });
});

describe("ManageAgents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists each agent's activity and disconnects one", () => {
    mockUseConnectedClients.mockReturnValue({
      data: [
        record({
          clientId: "claude-code",
          lastSeenAt: daysAgo(0),
          deviceNames: ["work-laptop"],
        }),
        record({ clientId: "codex", lastSeenAt: daysAgo(10) }),
        record({ clientId: "cursor" }),
      ],
    });
    const { agents } = renderHook(() => useConnectedAgents()).result.current;

    render(<ManageAgents data={data} agents={agents} />);
    fireEvent.click(
      screen.getByRole("button", { name: "3 connected · Manage" }),
    );

    expect(screen.getByText(/on work-laptop/)).toBeInTheDocument();
    expect(screen.getByText(/^Active/)).toBeInTheDocument();
    expect(
      screen.getByText(/^No activity in 7 days, last/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No activity in the last 30 days"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
    expect(
      screen.getByText(/disconnect\.md\?client=codex/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(mockDisconnect).toHaveBeenCalledWith("codex");
  });

  it("shows nothing without connected agents", () => {
    const { container } = render(<ManageAgents data={data} agents={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
