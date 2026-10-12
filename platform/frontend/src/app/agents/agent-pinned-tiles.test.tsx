import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { AgentPinnedTiles } from "./agent-pinned-tiles";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/agent.query", () => ({ useProfile: vi.fn() }));

const agent = (id: string, name: string) => ({
  id,
  name,
  agentType: "agent" as const,
  builtIn: false,
  icon: null,
  description: null,
  runtime: null,
  lastUsedAt: null,
});

describe("AgentPinnedTiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockReturnValue(false);
    // Agents pinned for the viewer that are not on the page are read by id.
    vi.mocked(useProfile).mockImplementation(
      (id) =>
        ({
          data: id === "org-default" ? agent("org-default", "Helpdesk") : null,
        }) as ReturnType<typeof useProfile>,
    );
  });

  it("pins the viewer's defaults for them, one tile per agent with every reason, and no unpin on those", () => {
    render(
      <AgentPinnedTiles
        pinned={[agent("mine", "Budget Allocator")]}
        inView={[agent("assistant", "My Assistant")]}
        pinnedFor={[
          { id: "assistant", reasons: ["Your default", "Personal agent"] },
          { id: "org-default", reasons: ["Org default"] },
        ]}
        onUnpin={vi.fn()}
        isLoading={false}
      />,
    );

    const tiles = screen.getAllByRole("listitem");
    expect(tiles.map((tile) => within(tile).getAllByRole("link")[0])).toEqual([
      screen.getByRole("link", { name: "My Assistant" }),
      screen.getByRole("link", { name: "Helpdesk" }),
      screen.getByRole("link", { name: "Budget Allocator" }),
    ]);
    expect(tiles[0]).toHaveTextContent("Your default");
    expect(tiles[0]).toHaveTextContent("Personal agent");
    expect(tiles[1]).toHaveTextContent("Org default");
    expect(
      within(tiles[0]).getByRole("img", {
        name: "Pinned automatically because it's your default agent and it's your personal chat agent",
      }),
    ).toBeInTheDocument();
    expect(within(tiles[0]).queryByRole("button", { name: /^Unpin/ })).toBe(
      null,
    );
  });

  it("lets the viewer unpin what they pinned themselves", async () => {
    const onUnpin = vi.fn();
    render(
      <AgentPinnedTiles
        pinned={[agent("mine", "Budget Allocator")]}
        inView={[]}
        pinnedFor={[]}
        onUnpin={onUnpin}
        isLoading={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Unpin Budget Allocator" }),
    );
    expect(onUnpin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mine" }),
    );
  });

  it("renders nothing when nothing is pinned", () => {
    const { container } = render(
      <AgentPinnedTiles
        pinned={[]}
        inView={[]}
        pinnedFor={[]}
        onUnpin={vi.fn()}
        isLoading={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
