import { render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageLayout } from "@/components/page-layout";

vi.mock("next/navigation");

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

describe("PageLayout tabs", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/abc");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  /**
   * A tab is rendered more than once — a desktop row plus a mobile row, and an
   * overflow popover past `mobileVisibleCount`. A test id must still identify a
   * single element, or every strict-mode locator for it fails.
   */
  it("renders a tab's test id exactly once, even though the tab itself is rendered per breakpoint", () => {
    render(
      <PageLayout
        title="Server"
        description=""
        tabs={[
          { label: "Overview", href: "/mcp/registry/abc" },
          {
            label: <span>Credentials</span>,
            href: "/mcp/registry/abc?tab=credentials",
            testId: "credentials-tab",
          },
        ]}
      >
        <div />
      </PageLayout>,
    );

    // Both breakpoints render the tab, so the label itself is duplicated...
    expect(screen.getAllByText("Credentials").length).toBeGreaterThan(1);
    // ...but the test id resolves to a single element.
    expect(screen.getAllByTestId("credentials-tab")).toHaveLength(1);
  });

  it("keeps the label and its count under the test id, so callers can read the count off it", () => {
    render(
      <PageLayout
        title="Server"
        description=""
        tabs={[
          {
            label: (
              <span>
                <span>Credentials</span>
                <span>2</span>
              </span>
            ),
            href: "/mcp/registry/abc?tab=credentials",
            testId: "credentials-tab",
          },
        ]}
      >
        <div />
      </PageLayout>,
    );

    expect(screen.getByTestId("credentials-tab")).toHaveTextContent(
      /Credentials\s*2/,
    );
  });

  it("does not emit a data-testid attribute for tabs that declare none", () => {
    render(
      <PageLayout
        title="Server"
        description=""
        tabs={[{ label: "Overview", href: "/mcp/registry/abc" }]}
      >
        <div />
      </PageLayout>,
    );

    expect(
      document.querySelectorAll("[data-testid]:not([data-testid=''])"),
    ).toHaveLength(0);
  });
});
