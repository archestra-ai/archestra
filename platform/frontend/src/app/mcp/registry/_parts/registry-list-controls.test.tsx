import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  emptyRegistryFilters,
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
