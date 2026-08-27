import { render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsSectionLayout } from "./logs-section-layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

describe("LogsSectionLayout", () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("renders the section header and tabs on the list route", () => {
    vi.mocked(usePathname).mockReturnValue("/llm/logs");

    render(
      <LogsSectionLayout listPath="/llm/logs">
        <div>list content</div>
      </LogsSectionLayout>,
    );

    expect(screen.getByRole("heading", { name: "Logs" })).toBeVisible();
    // PageLayout renders every tab twice, in a desktop row and a mobile one.
    expect(
      screen.getAllByRole("link", { name: "MCP Gateway" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("list content")).toBeVisible();
  });

  it("hands a detail route through without the section header", () => {
    // The detail pages render their own PageLayout naming the record they are
    // about. Wrapping them here too gave the page two headers stacked on each
    // other, with the record's own title and back link stranded in the body
    // below the tab bar.
    vi.mocked(usePathname).mockReturnValue("/llm/logs/session/abc");

    render(
      <LogsSectionLayout listPath="/llm/logs">
        <div>detail content</div>
      </LogsSectionLayout>,
    );

    expect(screen.getByText("detail content")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Logs" })).toBeNull();
    expect(screen.queryAllByRole("link", { name: "MCP Gateway" })).toHaveLength(
      0,
    );
  });

  it("keeps the header for a sibling segment's list route", () => {
    // Each segment passes its own list path, so /mcp/logs is a detail route to
    // the LLM layout and a list route to its own.
    vi.mocked(usePathname).mockReturnValue("/mcp/logs");

    render(
      <LogsSectionLayout listPath="/mcp/logs">
        <div>mcp list</div>
      </LogsSectionLayout>,
    );

    expect(screen.getByRole("heading", { name: "Logs" })).toBeVisible();
  });
});
