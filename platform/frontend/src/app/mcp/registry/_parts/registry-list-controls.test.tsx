import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  emptyRegistryFilters,
  RegistryAttentionFacets,
  RegistryFilterChips,
} from "./registry-list-controls";

const counts = { you: 2, others: 1, muted: 0 };

describe("RegistryAttentionFacets", () => {
  it("names the visible actor for non-admin viewers", () => {
    render(
      <RegistryAttentionFacets
        counts={counts}
        totalCount={6}
        othersLabel="Waiting action by owner@example.com"
        showOthers
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Waiting action by owner@example.com (1)",
      }),
    ).toBeInTheDocument();
    const facets = screen.getByTestId("mcp-registry-attention-facets");
    const beta = screen.getByText("Beta");
    expect(beta.previousElementSibling).toBe(facets);
  });

  it("omits the waiting facet for an installation admin", () => {
    render(
      <RegistryAttentionFacets
        counts={{ ...counts, others: 0 }}
        totalCount={6}
        othersLabel="Waiting action by other user"
        showOthers={false}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "All (6)" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Action required (2)" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting action by/)).toBeNull();
  });
});

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
