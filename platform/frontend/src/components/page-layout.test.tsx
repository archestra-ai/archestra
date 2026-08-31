import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("accepts an explicitly selected tab for query-owned views", () => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=needs-my-action") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(
      <PageLayout
        title="MCP Registry"
        tabs={[
          { label: "All", href: "/mcp/registry", selected: false },
          {
            label: "Action required",
            href: "/mcp/registry?status=needs-my-action",
            selected: true,
            testId: "action-required-tab",
          },
        ]}
      >
        <div />
      </PageLayout>,
    );

    expect(screen.getByTestId("action-required-tab")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("link", { name: "All" })[0]).not.toHaveAttribute(
      "aria-current",
    );
  });

  /**
   * The reader is on exactly one page, so exactly one tab may carry the
   * selected treatment. A caller that hands `selected` something other than
   * "this is the open page" — a per-tab status, say — used to light up every
   * tab it was true for, and left several links claiming `aria-current="page"`
   * at once.
   */
  it("marks a single tab as the current page even when several claim to be selected", () => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/abc/tools");

    render(
      <PageLayout
        title="Server"
        tabs={[
          { label: "Overview", href: "/mcp/registry/abc", selected: true },
          {
            label: "Tools",
            href: "/mcp/registry/abc/tools",
            selected: true,
          },
          { label: "Logs", href: "/mcp/registry/abc/logs", selected: true },
        ]}
      >
        <div />
      </PageLayout>,
    );

    // The winner is rendered once per breakpoint row, so count distinct tabs.
    const current = [...document.querySelectorAll('[aria-current="page"]')];
    expect(current.length).toBeGreaterThan(0);
    expect(new Set(current.map((el) => el.getAttribute("href")))).toEqual(
      new Set(["/mcp/registry/abc"]),
    );
  });

  it("underlines only the tab matching the URL when no tab declares selection", () => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/abc/logs");

    render(
      <PageLayout title="Server" tabs={FIVE_TABS} mobileVisibleCount={5}>
        <div />
      </PageLayout>,
    );

    // Desktop row plus mobile row: the same one tab, and nothing else.
    const current = [...document.querySelectorAll('[aria-current="page"]')];
    expect(current.length).toBeGreaterThan(0);
    expect(new Set(current.map((el) => el.getAttribute("href")))).toEqual(
      new Set(["/mcp/registry/abc/logs"]),
    );
  });

  /**
   * A filter deep-link (`?keyType=passthrough`) used to defeat the exact-path
   * match, and the URL then prefix-matched the parent tab instead — the page
   * rendered with the wrong tab underlined.
   */
  it("keeps the path's own tab active when the URL carries a query string", () => {
    vi.mocked(usePathname).mockReturnValue("/llm/proxy/virtual-keys");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("keyType=passthrough") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(
      <PageLayout
        title="Virtual Keys"
        tabs={[
          { label: "LLM Proxy", href: "/llm/proxy" },
          { label: "Virtual Keys", href: "/llm/proxy/virtual-keys" },
          { label: "OAuth Clients", href: "/llm/proxy/oauth-clients" },
        ]}
      >
        <div />
      </PageLayout>,
    );

    const current = [...document.querySelectorAll('[aria-current="page"]')];
    expect(current.length).toBeGreaterThan(0);
    expect(new Set(current.map((el) => el.getAttribute("href")))).toEqual(
      new Set(["/llm/proxy/virtual-keys"]),
    );
  });

  /**
   * Below `md` the tab row shows the first `mobileVisibleCount` tabs and folds
   * the rest into a popover. Both rows are in the DOM at once, so a tab past
   * the cut appears exactly once (the desktop row) until the popover is opened.
   */
  it("folds tabs past the mobile cut into an overflow popover", async () => {
    const user = userEvent.setup();
    render(
      <PageLayout title="Server" description="" tabs={FIVE_TABS}>
        <div />
      </PageLayout>,
    );

    // The first three are in both rows; the last two only in the desktop one.
    expect(screen.getAllByText("Overview")).toHaveLength(2);
    expect(screen.getAllByText("Logs")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /More/ }));

    expect(screen.getAllByText("Logs")).toHaveLength(2);
  });

  it("names the overflow trigger after the active tab rather than 'More'", () => {
    // Otherwise a mobile reader on a folded tab sees no indication of where
    // they are: every tab in the visible row reads inactive.
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/abc/logs");
    render(
      <PageLayout title="Server" description="" tabs={FIVE_TABS}>
        <div />
      </PageLayout>,
    );

    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Logs" })).toBeInTheDocument();
  });
});

/**
 * `status` arrived long after the 40-odd call sites that do not pass it, so
 * what it must not do is as much of the contract as what it does.
 */
describe("PageLayout header", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/agents/abc");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  it("renders a legacy caller's header with nothing extra in it", () => {
    render(
      <PageLayout
        title="Agents"
        description="Agents are AI assistants."
        actionButton={<button type="button">Create Agent</button>}
      >
        <div>body</div>
      </PageLayout>,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Agents");
    expect(screen.getByText("Agents are AI assistants.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    // No empty status shell: an "Active" pill on every record is the row this
    // prop exists to keep optional.
    expect(heading.parentElement?.children).toHaveLength(1);
  });

  it("keeps a composed title's icon and badges inside the heading", () => {
    // Detail pages pass markup as `title`, not a string, and the heading row
    // has to stay a container for it rather than assuming a bare name.
    render(
      <PageLayout
        title={
          <span>
            <svg role="img" aria-label="agent icon" />
            <span>Support Bot</span>
            <span>Personal</span>
          </span>
        }
        documentTitle="Support Bot"
      >
        <div />
      </PageLayout>,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Support Bot");
    expect(heading).toHaveTextContent("Personal");
    expect(heading.querySelector("[aria-label='agent icon']")).not.toBeNull();
  });

  it("puts the status pill beside the heading, never inside its name", () => {
    render(
      <PageLayout
        title="filesystem"
        status={<span>Not reachable</span>}
        description="An MCP server."
      >
        <div />
      </PageLayout>,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("filesystem");
    // A live probe result folded into the heading would rename the page every
    // time the probe changed.
    expect(heading).not.toHaveTextContent("Not reachable");
    expect(screen.getByText("Not reachable")).toBeInTheDocument();
  });

  it("lets a long title shrink instead of pushing the actions off the row", () => {
    // The heading is a flex item now that the status pill sits beside it, and
    // a flex item without `min-w-0` refuses to shrink below its content: the
    // title would keep its full width and shove the action button out of the
    // header instead of truncating.
    render(
      <PageLayout
        title={"A gateway with a very long name ".repeat(8)}
        actionButton={<button type="button">Edit</button>}
      >
        <div />
      </PageLayout>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("min-w-0");
  });

  it("does not change header height when an action is present without a description", () => {
    render(
      <PageLayout
        title="Edit agent"
        description=""
        actionButton={<button type="button">Step 1</button>}
      >
        <div />
      </PageLayout>,
    );

    expect(
      screen.getByRole("heading", { level: 1 }).parentElement,
    ).not.toHaveClass("mb-2");
  });

  it("floors table pages at phone width so copy does not collapse to a sliver", () => {
    const { container } = render(
      <PageLayout minWidth="phone" title="Costs">
        <div>tables</div>
      </PageLayout>,
    );

    expect(
      container.querySelectorAll(".min-w-\\[20rem\\]").length,
    ).toBeGreaterThan(0);
    const header = container.querySelector("[data-page-header]");
    expect(header?.parentElement).not.toHaveClass("overflow-x-auto");
    expect(header?.nextElementSibling).toHaveClass("overflow-x-auto");
  });

  it("gives every wizard-width detail page the safe phone floor by default", () => {
    const { container } = render(
      <PageLayout maxWidth="wizard" title="Edit agent">
        <div>form</div>
      </PageLayout>,
    );

    expect(
      container.querySelectorAll(".min-w-\\[20rem\\]").length,
    ).toBeGreaterThan(0);
  });

  it("keeps wizard and detail header copy within one shared height contract", () => {
    render(
      <PageLayout
        maxWidth="wizard"
        title="Add a new skill"
        description="Choose where the skill comes from before configuring it."
      >
        <div />
      </PageLayout>,
    );

    expect(
      screen.getByRole("heading", { level: 1 }).parentElement?.parentElement,
    ).toHaveClass("min-h-10", "sm:h-[3.75rem]");
    expect(document.querySelector("[data-page-description]")).toHaveClass(
      "hidden",
      "sm:line-clamp-1",
    );
  });
});

const FIVE_TABS = [
  { label: "Overview", href: "/mcp/registry/abc" },
  { label: "Tools", href: "/mcp/registry/abc/tools" },
  { label: "Credentials", href: "/mcp/registry/abc/credentials" },
  { label: "Logs", href: "/mcp/registry/abc/logs" },
  { label: "Settings", href: "/mcp/registry/abc/settings" },
];
