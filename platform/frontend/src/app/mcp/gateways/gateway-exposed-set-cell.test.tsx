import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExposedSetCell, ExposedSetNames } from "./gateway-exposed-set-cell";
import { gatewaySubagentNames, gatewayToolNames } from "./gateway-tools";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: { ...actual.archestraApiSdk, getAgents: vi.fn() },
  };
});
vi.mock("sonner");

const getAgents = vi.mocked(archestraApiSdk.getAgents);

const listed = (
  tools: Array<{ name: string; delegateToAgentId: string | null }>,
) => ({ data: { data: [{ id: "gw-1", tools }] }, error: undefined }) as never;

function renderRow({
  toolsCount = 2,
  subagentsCount = 1,
  status,
}: {
  toolsCount?: number;
  subagentsCount?: number;
  status?: "active" | "deleted";
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const names = (noun: string, kind: "tool" | "subagent") => (
    <ExposedSetNames
      gatewayId="gw-1"
      agentTypes={["mcp_gateway", "profile"]}
      status={status}
      noun={noun}
      pick={kind === "tool" ? gatewayToolNames : gatewaySubagentNames}
    />
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ExposedSetCell
        exposesEverything={false}
        everythingLabel="All tools"
        count={toolsCount}
        noun="tool"
        names={names("tool", "tool")}
      />
      <ExposedSetCell
        exposesEverything={false}
        everythingLabel="All subagents"
        count={subagentsCount}
        noun="subagent"
        names={names("subagent", "subagent")}
      />
    </QueryClientProvider>,
  );
}

const tooltip = () => screen.findByRole("tooltip");

describe("ExposedSetCell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the counts from the list row and reads no names until a tooltip opens", () => {
    renderRow({ toolsCount: 412, subagentsCount: 3 });

    expect(screen.getByText("412 selected")).toBeInTheDocument();
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(getAgents).not.toHaveBeenCalled();
  });

  it("says None for a zero count without reading names", async () => {
    renderRow({ toolsCount: 0, subagentsCount: 0 });

    expect(screen.getAllByText("None")).toHaveLength(2);
    await userEvent.hover(screen.getAllByText("None")[0]);
    expect(getAgents).not.toHaveBeenCalled();
  });

  it("reads one gateway's tools on hover and shares the read between the Tools and Subagents tooltips", async () => {
    getAgents.mockResolvedValue(
      listed([
        { name: "search", delegateToAgentId: null },
        { name: "fetch", delegateToAgentId: null },
        { name: "agent__helper", delegateToAgentId: "agent-2" },
      ]),
    );
    renderRow();

    await userEvent.hover(screen.getByText("2 selected"));
    expect(await tooltip()).toHaveTextContent("search, fetch");
    expect(getAgents).toHaveBeenCalledWith({
      query: {
        ids: ["gw-1"],
        includeTools: true,
        limit: 1,
        agentTypes: ["mcp_gateway", "profile"],
        status: undefined,
      },
    });

    await userEvent.unhover(screen.getByText("2 selected"));
    await userEvent.hover(screen.getByText("1 selected"));
    expect(
      await screen.findByRole("tooltip", { name: "agent__helper" }),
    ).toBeInTheDocument();
    expect(getAgents).toHaveBeenCalledTimes(1);
  });

  it("says the names are loading, then that they failed to load", async () => {
    let fail: ((value: never) => void) | undefined;
    getAgents.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          fail = resolve;
        }),
    );
    renderRow();

    await userEvent.hover(screen.getByText("2 selected"));
    expect(await tooltip()).toHaveTextContent("Loading tool names…");
    fail?.({
      data: undefined,
      error: { error: { message: "boom", type: "api_internal_server_error" } },
    } as never);
    expect(
      await screen.findByRole("tooltip", {
        name: "Couldn't load tool names. Hover again to retry.",
      }),
    ).toBeInTheDocument();
  });

  it("reads a trashed gateway's names from the deleted list", async () => {
    getAgents.mockResolvedValue(
      listed([{ name: "search", delegateToAgentId: null }]),
    );
    renderRow({ status: "deleted" });

    await userEvent.hover(screen.getByText("2 selected"));
    expect(await tooltip()).toHaveTextContent("search");
    expect(getAgents).toHaveBeenCalledWith({
      query: expect.objectContaining({ ids: ["gw-1"], status: "deleted" }),
    });
  });
});
