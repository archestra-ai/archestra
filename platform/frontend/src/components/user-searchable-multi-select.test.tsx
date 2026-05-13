import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserSearchableMultiSelect } from "./user-searchable-multi-select";

describe("UserSearchableMultiSelect", () => {
  const mockUsers = [
    { userId: "user-1", name: "John Doe", email: "john@example.com" },
    { userId: "user-2", name: "Jane Smith", email: "jane@example.com" },
    { userId: "user-3", name: "Bob Wilson", email: "bob@example.com" },
  ];

  it("renders with placeholder when no users selected", () => {
    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
        placeholder="Select users..."
      />,
    );

    expect(screen.getByText("Select users...")).toBeInTheDocument();
  });

  it("opens dropdown when clicking combobox", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(
      screen.getByPlaceholderText("Search users by name or email"),
    ).toBeInTheDocument();
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
  });

  it("selects a user when clicked", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={onValueChange}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /John Doe/i }));

    expect(onValueChange).toHaveBeenCalledWith(["user-1"]);
  });

  it("deselects a user when clicked again", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableMultiSelect
        value={["user-1"]}
        onValueChange={onValueChange}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /John Doe/i }));

    expect(onValueChange).toHaveBeenCalledWith([]);
  });

  it("selects multiple users", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    const { rerender } = render(
      <UserSearchableMultiSelect
        value={["user-1"]}
        onValueChange={onValueChange}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Jane Smith/i }));

    expect(onValueChange).toHaveBeenCalledWith(["user-1", "user-2"]);

    rerender(
      <UserSearchableMultiSelect
        value={["user-1", "user-2"]}
        onValueChange={onValueChange}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Bob Wilson/i }));
    expect(onValueChange).toHaveBeenLastCalledWith([
      "user-1",
      "user-2",
      "user-3",
    ]);
  });

  it("shows selected users as badges", () => {
    render(
      <UserSearchableMultiSelect
        value={["user-1", "user-2"]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("removes user when clicking X on badge", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableMultiSelect
        value={["user-1", "user-2"]}
        onValueChange={onValueChange}
        users={mockUsers}
      />,
    );

    const badges = screen.getAllByRole("button", { name: "" });
    await user.click(badges[0]);

    expect(onValueChange).toHaveBeenCalledWith(["user-2"]);
  });

  it("filters users by search query", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "jane",
    );

    expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.queryByText("Bob Wilson")).not.toBeInTheDocument();
  });

  it("filters users by email search", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "bob@example",
    );

    expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    expect(screen.queryByText("Jane Smith")).not.toBeInTheDocument();
    expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
  });

  it("shows empty message when no users match search", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
        emptyMessage="No users found"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "zzzz",
    );

    expect(screen.getByText("No users found")).toBeInTheDocument();
  });

  it("shows email as description for available users", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("john@example.com")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("disables users whose userId is in disabledUserIds", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={onValueChange}
        users={mockUsers}
        disabledUserIds={new Set(["user-1"])}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const disabledItem = screen.getByRole("button", {
      name: /John Doe/i,
    });
    expect(disabledItem).toBeDisabled();

    await user.click(disabledItem);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("respects maxSelected limit", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableMultiSelect
        value={["user-1"]}
        onValueChange={onValueChange}
        users={mockUsers}
        maxSelected={1}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Jane Smith/i }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("shows +N more badge when exceeding maxBadgeDisplay", () => {
    render(
      <UserSearchableMultiSelect
        value={["user-1", "user-2", "user-3"]}
        onValueChange={vi.fn()}
        users={mockUsers}
        maxBadgeDisplay={2}
      />,
    );

    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.queryByText("Bob Wilson")).not.toBeInTheDocument();
  });

  it("hides badges when showSelectedBadges is false", () => {
    render(
      <UserSearchableMultiSelect
        value={["user-1", "user-2"]}
        onValueChange={vi.fn()}
        users={mockUsers}
        showSelectedBadges={false}
        selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
      />,
    );

    expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    expect(screen.queryByText("Jane Smith")).not.toBeInTheDocument();
    expect(screen.getByText("2 users selected")).toBeInTheDocument();
  });

  it("shows selected suffix text with custom function", () => {
    render(
      <UserSearchableMultiSelect
        value={["user-1"]}
        onValueChange={vi.fn()}
        users={mockUsers}
        showSelectedBadges={false}
        selectedSuffix={(n) => `${n === 1 ? "item" : "items"} chosen`}
      />,
    );

    expect(screen.getByText("1 item chosen")).toBeInTheDocument();
  });

  it("shows selected suffix text with string suffix", () => {
    render(
      <UserSearchableMultiSelect
        value={["user-1", "user-2"]}
        onValueChange={vi.fn()}
        users={mockUsers}
        showSelectedBadges={false}
        selectedSuffix="picked"
      />,
    );

    expect(screen.getByText("2 picked")).toBeInTheDocument();
  });

  it("disables the combobox when disabled prop is true", () => {
    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
        disabled
      />,
    );

    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("uses userId as fallback when name and email are missing", () => {
    const usersWithNoName = [{ userId: "user-abc" }];

    render(
      <UserSearchableMultiSelect
        value={["user-abc"]}
        onValueChange={vi.fn()}
        users={usersWithNoName}
      />,
    );

    expect(screen.getByText("user-abc")).toBeInTheDocument();
  });

  it("uses email as fallback when name is missing", async () => {
    const user = userEvent.setup();
    const usersWithEmailOnly = [
      { userId: "user-1", email: "test@example.com" },
    ];

    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={usersWithEmailOnly}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const items = screen.getAllByText("test@example.com");
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("shows checkmark for selected users", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableMultiSelect
        value={["user-1"]}
        onValueChange={vi.fn()}
        users={mockUsers}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const buttons = screen.getAllByRole("button");
    const selectedButton = buttons.find((b) =>
      b.textContent?.includes("John Doe"),
    );
    expect(selectedButton).toHaveClass("bg-accent");
  });

  it("applies custom className to combobox", () => {
    render(
      <UserSearchableMultiSelect
        value={[]}
        onValueChange={vi.fn()}
        users={mockUsers}
        className="my-custom-class"
      />,
    );

    expect(screen.getByRole("combobox")).toHaveClass("my-custom-class");
  });
});
