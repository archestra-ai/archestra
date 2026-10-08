import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedClient } from "@/lib/connected-client.query";
import { CONNECT_CLIENTS } from "./clients";
import type { ConnectPageData } from "./connect-page-data";
import {
  DisconnectLine,
  ManageAgents,
  useConnectedAgents,
} from "./connected-agents";

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
    name: "Claude Code",
    lastConnectedAt: daysAgo(1),
    deviceNames: [],
    lastSeenAt: null,
    ...overrides,
  };
}

const data = {
  appName: "Acme",
  baseUrl: "http://localhost:3000/v1",
  clients: CONNECT_CLIENTS,
  featuredClients: [],
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

  it("keeps an agent no app lists, under the name it signed in with", () => {
    mockUseConnectedClients.mockReturnValue({
      data: [
        record({
          clientId: "oauth:https://hermes.example/client",
          name: "Hermes Agent",
        }),
      ],
    });

    const { result } = renderHook(() => useConnectedAgents());

    expect(result.current.agents).toHaveLength(1);
    expect(result.current.agents[0].client).toMatchObject({
      id: "oauth:https://hermes.example/client",
      label: "Hermes Agent",
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

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

describe("DisconnectLine", () => {
  const client = (id: string) => {
    const found = CONNECT_CLIENTS.find((c) => c.id === id);
    if (!found) throw new Error(`${id} client missing`);
    return found;
  };

  it("explains disconnecting before anything is connected", () => {
    render(
      <DisconnectLine data={data} picked={client("claude-code")} agents={[]} />,
    );
    expect(
      screen.getByText(/You can disconnect at any time/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));

    expect(screen.getByText("Disconnecting an agent")).toBeInTheDocument();
    // Opens on the agent picked on the page.
    expect(
      screen.getByText(/disconnect\.md\?client=claude-code/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Once it's connected, open Manage on this page, press Disconnect, then Revoke access.",
      ),
    ).toBeInTheDocument();
  });

  it("gives the generic client the prompt for any agent", () => {
    render(
      <DisconnectLine data={data} picked={client("generic")} agents={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(
      screen.getByText(
        "Read http://localhost:3000/disconnect.md and disconnect this agent from Acme.",
      ),
    ).toBeInTheDocument();
  });

  it("lists what gets removed only when asked", () => {
    render(
      <DisconnectLine data={data} picked={client("claude-code")} agents={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.queryByText(/MCP server entry/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText(/MCP server entry/)).toBeInTheDocument();
  });

  it("offers Manage once something is connected, and How it works inside it", () => {
    mockUseConnectedClients.mockReturnValue({
      data: [record({ clientId: "codex" }), record({ clientId: "cursor" })],
    });
    const { agents } = renderHook(() => useConnectedAgents()).result.current;
    render(
      <DisconnectLine
        data={data}
        picked={client("claude-code")}
        agents={agents}
      />,
    );
    expect(screen.getByText(/2 connected/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How it works" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Manage connected agents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.getByText("Disconnecting an agent")).toBeInTheDocument();
  });
});
