import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchableMultiSelect } from "./searchable-multi-select";

const mockItems = [
  { value: "item-1", label: "Item One", searchText: "first item" },
  { value: "item-2", label: "Item Two", searchText: "second item" },
  { value: "item-3", label: "Item Three", searchText: "third item" },
];

describe("SearchableMultiSelect", () => {
  it("renders with placeholder when no items selected", () => {
    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        placeholder="Select items..."
        items={mockItems}
      />,
    );

    expect(screen.getByText("Select items...")).toBeInTheDocument();
  });

  it("opens dropdown when clicking combobox", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    expect(screen.getByText("Item One")).toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
    expect(screen.getByText("Item Three")).toBeInTheDocument();
  });

  it("selects an item when clicked", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={onValueChange}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Item One/i }));

    expect(onValueChange).toHaveBeenCalledWith(["item-1"]);
  });

  it("deselects an item when clicked again", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={onValueChange}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Item One/i }));

    expect(onValueChange).toHaveBeenCalledWith([]);
  });

  it("selects multiple items", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    const { rerender } = render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={onValueChange}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Item Two/i }));

    expect(onValueChange).toHaveBeenCalledWith(["item-1", "item-2"]);

    rerender(
      <SearchableMultiSelect
        value={["item-1", "item-2"]}
        onValueChange={onValueChange}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Item Three/i }));
    expect(onValueChange).toHaveBeenLastCalledWith([
      "item-1",
      "item-2",
      "item-3",
    ]);
  });

  it("shows selected items as badges", () => {
    render(
      <SearchableMultiSelect
        value={["item-1", "item-2"]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    expect(screen.getByText("Item One")).toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
  });

  it("removes item when clicking X on badge", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableMultiSelect
        value={["item-1", "item-2"]}
        onValueChange={onValueChange}
        items={mockItems}
      />,
    );

    const badges = screen.getAllByRole("button", { name: "" });
    await user.click(badges[0]);

    expect(onValueChange).toHaveBeenCalledWith(["item-2"]);
  });

  it("filters items by search query", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "second");

    expect(screen.queryByText("Item One")).not.toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
    expect(screen.queryByText("Item Three")).not.toBeInTheDocument();
  });

  it("filters items by searchText when provided", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "third");

    expect(screen.queryByText("Item One")).not.toBeInTheDocument();
    expect(screen.queryByText("Item Two")).not.toBeInTheDocument();
    expect(screen.getByText("Item Three")).toBeInTheDocument();
  });

  it("shows empty message when no items match search", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        emptyMessage="Nothing found"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "zzzz");

    expect(screen.getByText("Nothing found")).toBeInTheDocument();
  });

  it("shows default empty message when no items match", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "zzzz");

    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("respects maxSelected limit", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={onValueChange}
        items={mockItems}
        maxSelected={1}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Item Two/i }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("shows +N more badge when exceeding maxBadgeDisplay", () => {
    render(
      <SearchableMultiSelect
        value={["item-1", "item-2", "item-3"]}
        onValueChange={vi.fn()}
        items={mockItems}
        maxBadgeDisplay={2}
      />,
    );

    expect(screen.getByText("Item One")).toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.queryByText("Item Three")).not.toBeInTheDocument();
  });

  it("shows text suffix when showSelectedBadges is false", () => {
    render(
      <SearchableMultiSelect
        value={["item-1", "item-2"]}
        onValueChange={vi.fn()}
        items={mockItems}
        showSelectedBadges={false}
        selectedSuffix={(n) => `${n === 1 ? "item" : "items"} selected`}
      />,
    );

    expect(screen.queryByText("Item One")).not.toBeInTheDocument();
    expect(screen.queryByText("Item Two")).not.toBeInTheDocument();
    expect(screen.getByText("2 items selected")).toBeInTheDocument();
  });

  it("shows string suffix when showSelectedBadges is false", () => {
    render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={vi.fn()}
        items={mockItems}
        showSelectedBadges={false}
        selectedSuffix="picked"
      />,
    );

    expect(screen.getByText("1 picked")).toBeInTheDocument();
  });

  it("disables the combobox when disabled prop is true", () => {
    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        disabled
      />,
    );

    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows disabled state on combobox", () => {
    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        disabled
      />,
    );

    expect(screen.getByRole("combobox")).toHaveClass("cursor-not-allowed");
    expect(screen.getByRole("combobox")).toHaveClass("opacity-50");
  });

  it("does not select disabled items", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    const itemsWithDisabled = [
      ...mockItems,
      { value: "item-4", label: "Item Four", disabled: true },
    ];

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={onValueChange}
        items={itemsWithDisabled}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const disabledButton = screen.getByRole("button", { name: /Item Four/i });
    expect(disabledButton).toBeDisabled();

    await user.click(disabledButton);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("renders custom content when provided", async () => {
    const user = userEvent.setup();

    const itemsWithContent = [
      {
        value: "item-1",
        label: "Item One",
        content: <div data-testid="custom-content">Custom One</div>,
      },
    ];

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={itemsWithContent}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByTestId("custom-content")).toBeInTheDocument();
  });

  it("renders custom selectedContent in badges", () => {
    const itemsWithSelectedContent = [
      {
        value: "item-1",
        label: "Item One",
        selectedContent: <span data-testid="custom-badge">Badge One</span>,
      },
    ];

    render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={vi.fn()}
        items={itemsWithSelectedContent}
      />,
    );

    expect(screen.getByTestId("custom-badge")).toBeInTheDocument();
  });

  it("hides search icon when showSearchIcon is false", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        showSearchIcon={false}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("img", { hidden: true })).not.toBeInTheDocument();
  });

  it("opens dropdown on Enter key", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    screen.getByRole("combobox").focus();
    await user.keyboard("{Enter}");

    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("opens dropdown on Space key", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    screen.getByRole("combobox").focus();
    await user.keyboard(" ");

    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("respects custom search placeholder", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        searchPlaceholder="Find items..."
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByPlaceholderText("Find items...")).toBeInTheDocument();
  });

  it("applies custom className to combobox", () => {
    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        className="my-custom-class"
      />,
    );

    expect(screen.getByRole("combobox")).toHaveClass("my-custom-class");
  });

  it("applies custom contentClassName to popover", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        contentClassName="custom-content"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(
      screen.getByPlaceholderText("Search...").closest("[data-state]"),
    ).toHaveClass("custom-content");
  });

  it("applies custom listClassName to item list", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
        listClassName="custom-list"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(
      screen.getByRole("button", { name: /Item One/i }).parentElement,
    ).toHaveClass("custom-list");
  });

  it("shows checkmark for selected items", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={["item-1"]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const buttons = screen.getAllByRole("button");
    const selectedButton = buttons.find((b) =>
      b.textContent?.includes("Item One"),
    );
    expect(selectedButton).toHaveClass("bg-accent");
  });

  it("filters and shows only matching items", async () => {
    const user = userEvent.setup();

    render(
      <SearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        items={mockItems}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search..."), "second");

    expect(screen.queryByText("Item One")).not.toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
    expect(screen.queryByText("Item Three")).not.toBeInTheDocument();
  });
});
