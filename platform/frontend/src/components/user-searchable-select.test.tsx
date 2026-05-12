import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserSearchableSelect } from "./user-searchable-select";

describe("UserSearchableSelect", () => {
  it("calls onValueChange with userId", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={onValueChange}
        users={[
          {
            userId: "user-456",
            name: "John Doe",
            email: "john@example.com",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /John Doe/i }));

    expect(onValueChange).toHaveBeenCalledWith("user-456");
  });

  it("calls onValueChange with userId even when name and email are missing", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={onValueChange}
        users={[
          {
            userId: "user-789",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /user-789/i }));

    expect(onValueChange).toHaveBeenCalledWith("user-789");
  });

  it("disables users whose userId is in disabledUserIds", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={onValueChange}
        users={[
          {
            userId: "user-1",
            name: "Already Added",
            email: "added@example.com",
          },
          {
            userId: "user-2",
            name: "Available",
            email: "available@example.com",
          },
        ]}
        disabledUserIds={new Set(["user-1"])}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const disabledItem = screen.getByRole("button", {
      name: /Already Added/i,
    });
    expect(disabledItem).toBeDisabled();

    await user.click(disabledItem);
    expect(onValueChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Available/i }));
    expect(onValueChange).toHaveBeenCalledWith("user-2");
  });

  it("shows email as description for available users", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={vi.fn()}
        users={[
          {
            userId: "user-1",
            name: "John Doe",
            email: "john@example.com",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("john@example.com")).toBeInTheDocument();
  });

  it("filters users by email search query", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={vi.fn()}
        users={[
          { userId: "user-1", name: "John Doe", email: "john@example.com" },
          { userId: "user-2", name: "Jane Smith", email: "jane@example.com" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "jane@example",
    );

    expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("filters users by name search query", async () => {
    const user = userEvent.setup();

    render(
      <UserSearchableSelect
        value=""
        onValueChange={vi.fn()}
        users={[
          { userId: "user-1", name: "John Doe", email: "john@example.com" },
          { userId: "user-2", name: "Jane Smith", email: "jane@example.com" },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "John",
    );

    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.queryByText("Jane Smith")).not.toBeInTheDocument();
  });
});
