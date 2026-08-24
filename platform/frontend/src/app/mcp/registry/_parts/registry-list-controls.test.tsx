import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  emptyRegistryFilters,
  RegistryDismissedFilter,
  RegistryFilterChips,
} from "./registry-list-controls";

describe("RegistryFilterChips", () => {
  it("uses the issue label instead of exposing its URL slug", () => {
    const selected = emptyRegistryFilters();
    selected.issue.add("failed-to-start");

    render(
      <RegistryFilterChips
        selected={selected}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Issue:")).toBeInTheDocument();
    expect(screen.getByText("Failed to start")).toBeInTheDocument();
    expect(screen.queryByText("failed-to-start")).toBeNull();
  });
});

describe("RegistryDismissedFilter", () => {
  it("states how many alerts are silenced and whether it is on", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <RegistryDismissedFilter count={4} pressed={false} onToggle={onToggle} />,
    );

    const button = screen.getByRole("button", { name: /Dismissed/ });
    expect(button).toHaveTextContent("(4)");
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reads as pressed while the dismissed alerts are the list", () => {
    render(<RegistryDismissedFilter count={4} pressed onToggle={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Dismissed/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
