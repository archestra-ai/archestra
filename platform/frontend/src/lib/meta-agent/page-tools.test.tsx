import { META_AGENT_UI_TOOL_NAMES } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  META_AGENT_IGNORE_ATTRIBUTE,
  metaAgentPageTools,
  type PageSnapshot,
} from "./page-tools";

describe("metaAgentPageTools", () => {
  beforeEach(() => {
    // jsdom has no layout engine: every element reports zero boxes, which the
    // snapshot reads as "not rendered". Give every element one box.
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 10, 10),
    ] as unknown as DOMRectList);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes the page with a ref per control, skipping hidden, closing, and ignored parts", async () => {
    render(
      <div>
        <h1>Teams</h1>
        <p>Manage teams</p>
        <button type="button">Create Team</button>
        <input aria-label="Search teams" placeholder="Search" />
        <button type="button" style={{ visibility: "hidden" }}>
          Hidden action
        </button>
        <div role="dialog" data-state="closed">
          Closing dialog
        </div>
        <section {...{ [META_AGENT_IGNORE_ATTRIBUTE]: "" }}>
          <button type="button">Assistant send</button>
        </section>
      </div>,
    );

    const snapshot = await getPage();

    expect(snapshot.content.split("\n")).toEqual(
      expect.arrayContaining([
        "# Teams",
        "Manage teams",
        '[1] button "Create Team"',
        '[2] textbox "Search teams" placeholder="Search"',
      ]),
    );
    expect(snapshot.content).not.toContain("Hidden action");
    expect(snapshot.content).not.toContain("Assistant send");
    expect(snapshot.content).not.toContain("Closing dialog");
  });

  it("fills a React-controlled input so the component sees the change", async () => {
    render(<ControlledSearch />);
    const snapshot = await getPage();
    const ref = refOf(snapshot, "Search teams");

    await metaAgentPageTools.execute(META_AGENT_UI_TOOL_NAMES.FILL, {
      ref,
      value: "platform",
    });

    expect(screen.getByTestId("query")).toHaveTextContent("platform");
  });

  it("clicks controls that only listen for pointerdown, like menu triggers", async () => {
    render(<PointerDownMenu />);
    const ref = refOf(await getPage(), "Open menu");

    await metaAgentPageTools.execute(META_AGENT_UI_TOOL_NAMES.CLICK, { ref });

    expect(screen.getByText("Menu is open")).toBeInTheDocument();
  });

  it("tells the model to re-snapshot when a ref no longer exists", async () => {
    render(<button type="button">Only</button>);
    await getPage();

    await expect(
      metaAgentPageTools.execute(META_AGENT_UI_TOOL_NAMES.CLICK, { ref: 99 }),
    ).rejects.toThrow(/take a fresh snapshot/);
  });
});

async function getPage(): Promise<PageSnapshot> {
  return metaAgentPageTools.execute(META_AGENT_UI_TOOL_NAMES.GET_PAGE, {});
}

function refOf(snapshot: PageSnapshot, name: string): number {
  const line = snapshot.content
    .split("\n")
    .find((entry) => entry.includes(`"${name}"`));
  return Number(/^\[(\d+)\]/.exec(line ?? "")?.[1]);
}

function ControlledSearch() {
  const [query, setQuery] = useState("");
  return (
    <div>
      <input
        aria-label="Search teams"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <span data-testid="query">{query}</span>
    </div>
  );
}

function PointerDownMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onPointerDown={() => setOpen(true)}>
        Open menu
      </button>
      {open && <span>Menu is open</span>}
    </div>
  );
}
