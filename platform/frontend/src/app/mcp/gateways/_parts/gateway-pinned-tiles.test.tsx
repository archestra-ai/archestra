import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDefaultMcpGateway, useProfile } from "@/lib/agent.query";
import { useOrganization } from "@/lib/organization.query";
import { GatewayPinnedTiles } from "./gateway-pinned-tiles";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/agent.query", () => ({
  useDefaultMcpGateway: vi.fn(),
  useProfile: vi.fn(),
}));
vi.mock("next/navigation");

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({
    prefetch: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});

type Gateway = Parameters<typeof GatewayPinnedTiles>[0]["pinned"][number];

const gateway = (
  id: string,
  name: string,
  tools: {
    accessAllTools: boolean;
    tools: NonNullable<Gateway["tools"]>;
  } = {
    accessAllTools: true,
    tools: [],
  },
): Gateway => ({
  id,
  name,
  agentType: "mcp_gateway",
  lastUsedAt: null,
  ...tools,
});

const personal = gateway("gw-personal", "My gateway");
const team = gateway("gw-team", "Team gateway");
const starred = gateway("gw-starred", "Starred gateway");

function setUp({
  personalGateway = personal as Gateway | null,
  connectDefaultId = null as string | null,
  readable = [] as Gateway[],
} = {}) {
  vi.mocked(useDefaultMcpGateway).mockReturnValue({
    data: personalGateway,
  } as unknown as ReturnType<typeof useDefaultMcpGateway>);
  vi.mocked(useOrganization).mockReturnValue({
    data: { connectionDefaultMcpGatewayId: connectDefaultId },
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useProfile).mockImplementation(
    (id) =>
      ({
        data: readable.find((candidate) => candidate.id === id) ?? null,
      }) as unknown as ReturnType<typeof useProfile>,
  );
}

function renderTiles({
  pinned = [] as Gateway[],
  inView = [] as Gateway[],
} = {}) {
  const onUnpin = vi.fn();
  render(
    <GatewayPinnedTiles
      pinned={pinned}
      inView={inView}
      onUnpin={onUnpin}
      isLoading={false}
    />,
  );
  return { onUnpin };
}

const tileFor = (name: string) =>
  screen.getByRole("link", { name }).closest("li") as HTMLElement;

describe("GatewayPinnedTiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins the viewer's personal gateway, which is also the Connect default, as one tile with both reasons", () => {
    setUp();
    renderTiles();

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    const tile = tileFor("My gateway");
    expect(within(tile).getByText("Personal")).toBeInTheDocument();
    expect(within(tile).getByText("Connect default")).toBeInTheDocument();
    expect(
      within(tile).getByRole("img", { name: /^Pinned automatically because / }),
    ).toBeInTheDocument();
    expect(
      within(tile).getByRole("link", { name: "Connect" }),
    ).toBeInTheDocument();
  });

  it("pins the organization's Connect default apart from the personal gateway, reading it when the list does not hold it", () => {
    setUp({ connectDefaultId: team.id, readable: [team] });
    renderTiles();

    const personalTile = tileFor("My gateway");
    expect(within(personalTile).getByText("Personal")).toBeInTheDocument();
    expect(
      within(personalTile).queryByText("Connect default"),
    ).not.toBeInTheDocument();

    const teamTile = tileFor("Team gateway");
    expect(within(teamTile).getByText("Connect default")).toBeInTheDocument();
    expect(within(teamTile).queryByText("Personal")).not.toBeInTheDocument();
    expect(
      within(teamTile).queryByRole("button", { name: /^Unpin/ }),
    ).not.toBeInTheDocument();
  });

  it("lets the viewer unpin only the gateways they pinned", async () => {
    setUp({ connectDefaultId: team.id });
    const { onUnpin } = renderTiles({
      // The Connect default is also pinned by hand: it still follows the
      // setting, so it is not the viewer's to unpin here.
      pinned: [starred, team],
      inView: [],
    });

    expect(
      screen.queryByRole("button", { name: "Unpin My gateway" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Unpin Team gateway" }),
    ).not.toBeInTheDocument();
    expect(
      within(tileFor("Starred gateway")).queryByText("Personal"),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Unpin Starred gateway" }),
    );
    expect(onUnpin).toHaveBeenCalledWith(starred);
  });

  it("says a gateway exposes all the viewer's tools, or counts its assigned tools leaving out subagents", async () => {
    setUp({ personalGateway: null });
    const tool = (name: string, delegateToAgentId: string | null = null) => ({
      name,
      delegateToAgentId,
    });
    renderTiles({
      pinned: [
        gateway("gw-all", "Everything gateway"),
        gateway("gw-one", "One-tool gateway", {
          accessAllTools: false,
          tools: [tool("search"), tool("helper", "agent-1")],
        }),
        gateway("gw-two", "Two-tool gateway", {
          accessAllTools: false,
          tools: [tool("search"), tool("fetch")],
        }),
      ],
    });

    const allChip = within(tileFor("Everything gateway")).getByText(
      "All your tools",
    );
    await userEvent.hover(allChip);
    expect(
      await screen.findByRole("tooltip", {
        name: "Exposes every tool you have access to.",
      }),
    ).toBeInTheDocument();
    expect(
      within(tileFor("One-tool gateway")).getByText("1 tool"),
    ).toBeInTheDocument();
    expect(
      within(tileFor("Two-tool gateway")).getByText("2 tools"),
    ).toBeInTheDocument();
  });

  it("counts a list row's tools from its count, which arrives without the tools", () => {
    setUp({ personalGateway: null });
    renderTiles({
      pinned: [
        {
          ...gateway("gw-listed", "Listed gateway"),
          accessAllTools: false,
          tools: undefined,
          toolsCount: 412,
        },
        {
          ...gateway("gw-single", "Single read gateway"),
          accessAllTools: false,
          tools: [{ name: "search", delegateToAgentId: null }],
        },
      ],
    });

    expect(
      within(tileFor("Listed gateway")).getByText("412 tools"),
    ).toBeInTheDocument();
    expect(
      within(tileFor("Single read gateway")).getByText("1 tool"),
    ).toBeInTheDocument();
  });

  it("shows no automatic tile when the viewer has no personal gateway and no Connect default is set", () => {
    setUp({ personalGateway: null });
    renderTiles();

    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
