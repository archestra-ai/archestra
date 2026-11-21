import { render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsSectionLayout } from "./logs-section-layout";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");

describe("LogsSectionLayout", () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("renders the section header on the list route", () => {
    vi.mocked(usePathname).mockReturnValue("/adoption");

    render(
      <LogsSectionLayout
        listPath="/adoption"
        title="Adoption"
        description="Who connected what."
      >
        <div>list content</div>
      </LogsSectionLayout>,
    );

    expect(screen.getByRole("heading", { name: "Adoption" })).toBeVisible();
    expect(screen.getByText("list content")).toBeVisible();
  });

  it("hands a detail route through without the section header", () => {
    // Detail pages render their own PageLayout naming the record they are
    // about; wrapping them here too would stack two headers.
    vi.mocked(usePathname).mockReturnValue("/adoption/abc");

    render(
      <LogsSectionLayout
        listPath="/adoption"
        title="Adoption"
        description="Who connected what."
      >
        <div>detail content</div>
      </LogsSectionLayout>,
    );

    expect(screen.getByText("detail content")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Adoption" })).toBeNull();
  });
});
