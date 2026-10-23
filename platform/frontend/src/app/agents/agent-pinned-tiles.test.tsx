import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { AgentPinnedTiles } from "./agent-pinned-tiles";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/agent.query", () => ({ useProfile: vi.fn() }));
vi.mock("next/navigation");

const prefetch = vi.fn();

beforeEach(() => {
  prefetch.mockReset();
  vi.mocked(useRouter).mockReturnValue({
    prefetch,
  } as unknown as ReturnType<typeof useRouter>);
});

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

  it("prefetches a tile's name link and its Chat button only on hover", () => {
    render(
      <AgentPinnedTiles
        pinned={[agent("mine", "Budget Allocator")]}
        inView={[]}
        pinnedFor={[]}
        onUnpin={vi.fn()}
        isLoading={false}
      />,
    );

    const name = screen.getByRole("link", { name: "Budget Allocator" });
    const chat = screen.getByRole("link", { name: "Chat" });
    expect(prefetch).not.toHaveBeenCalled();

    fireEvent.mouseEnter(name);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith(name.getAttribute("href"));

    fireEvent.mouseEnter(chat);
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenLastCalledWith(chat.getAttribute("href"));
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
