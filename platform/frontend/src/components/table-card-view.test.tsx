import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "./table-card-view";

describe("TableCardView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => createMediaQueryList()),
    );
  });

  it("persists and restores the selected desktop layout", async () => {
    window.localStorage.setItem("test-view", "table");

    render(<TestView />);

    await waitFor(() =>
      expect(screen.getByLabelText("View as table")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    fireEvent.click(screen.getByLabelText("View as cards"));

    expect(window.localStorage.getItem("test-view")).toBe("cards");
    expect(screen.getByText("Cards")).toBeVisible();
  });

  it("keeps cards rendered for mobile when table mode is selected", async () => {
    window.localStorage.setItem("test-view", "table");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });

    render(<TestView />);

    await waitFor(() =>
      expect(screen.getByLabelText("View as table")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    await waitFor(() => expect(screen.getByText("Cards")).toBeVisible());
    expect(screen.queryByText("Table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("View as table").closest("div")).toHaveClass(
      "hidden",
      "md:inline-flex",
    );
  });

  it("keeps bulk selection available on cards", () => {
    const onSelectedChange = vi.fn();

    render(
      <TableCard
        title="Knowledge source"
        selected={false}
        onSelectedChange={onSelectedChange}
        selectionLabel="Select Knowledge source"
      />,
    );

    fireEvent.click(screen.getByLabelText("Select Knowledge source"));

    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });

  it("shows the shared loader instead of an empty result while cards are loading", () => {
    render(
      <TableCardList itemCount={0} isLoading emptyMessage="No agents found">
        {null}
      </TableCardList>,
    );

    expect(
      screen.getByRole("status", { name: "Loading results…" }),
    ).toBeVisible();
    expect(screen.queryByText("No agents found")).not.toBeInTheDocument();
  });
});

function TestView() {
  return (
    <TableCardView storageKey="test-view">
      <TableCardViewToggle />
      <TableCardViewContent
        table={<span>Table</span>}
        cards={<span>Cards</span>}
      />
    </TableCardView>
  );
}

function createMediaQueryList(): MediaQueryList {
  return {
    matches: false,
    media: "(max-width: 767px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}
