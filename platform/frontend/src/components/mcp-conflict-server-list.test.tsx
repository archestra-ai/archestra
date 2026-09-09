import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { McpConflictServerList } from "./mcp-conflict-server-list";

describe("McpConflictServerList", () => {
  it("shows up to three names without an overflow control", () => {
    render(<McpConflictServerList names={["Files", "Search", "Database"]} />);
    expect(screen.getByText("Files, Search, Database")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("reveals only the remaining servers when the overflow control is focused", async () => {
    const user = userEvent.setup();
    render(
      <McpConflictServerList
        names={["Files", "Search", "Database", "Calendar", "Documents"]}
      />,
    );
    expect(screen.queryByText("Calendar")).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("button", { name: "2 more" })).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Calendar")).toBeInTheDocument();
    expect(within(tooltip).getByText("Documents")).toBeInTheDocument();
    expect(within(tooltip).queryByText("Files")).not.toBeInTheDocument();
  });
});
