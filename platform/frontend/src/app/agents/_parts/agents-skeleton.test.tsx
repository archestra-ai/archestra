import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsTableSkeleton } from "./agents-skeleton";

function columnHeaders() {
  return screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "")
    .filter(Boolean);
}

describe("AgentsTableSkeleton", () => {
  it("shows the table's columns without Environment by default", () => {
    render(<AgentsTableSkeleton rows={1} />);
    expect(columnHeaders()).toEqual([
      "Name",
      "Tools",
      "Subagents",
      "Last used",
      "Provider",
      "Actions",
    ]);
  });

  it("adds Environment between Provider and Actions, as the table does", () => {
    render(<AgentsTableSkeleton rows={1} showEnvironment />);
    expect(columnHeaders()).toEqual([
      "Name",
      "Tools",
      "Subagents",
      "Last used",
      "Provider",
      "Environment",
      "Actions",
    ]);
    expect(screen.getAllByRole("cell")).toHaveLength(8);
  });
});
