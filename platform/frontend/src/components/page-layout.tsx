"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

// Helper to determine if a tab's href matches the current URL
// Sort tabs by href length descending so we match the most specific first
function isTabActive(
  currentUrl: string,
  tabHref: string,
  allTabs: { href: string }[],
) {
  // Sort tabs by href length (longest first)
  const sortedTabs = [...allTabs].sort((a, b) => b.href.length - a.href.length);

  // Find the first tab that matches. A query string on the current URL must
  // not defeat the match: `/base/child?filter=x` belongs to the `/base/child`
  // tab, not to `/base` via the prefix rule.
  for (const tab of sortedTabs) {
    if (
      currentUrl === tab.href ||
      currentUrl.startsWith(`${tab.href}/`) ||
      currentUrl.startsWith(`${tab.href}?`)
    ) {
      return tab.href === tabHref;
    }
  }

  // Fallback to includes for backwards compatibility
  return currentUrl.includes(tabHref);
}

export function PageLayout({
  title,
  documentTitle,
  backLink,
  description,
  status,
  children,
  tabs = [],
  actionButton,
  mobileVisibleCount = 3,
  maxWidth: maxWidthKey = "wide",
  minWidth: minWidthKey = "none",
}: {
  children: React.ReactNode;
  /**
   * Tab bar entries. A tab is rendered more than once — a desktop row plus a
   * mobile row and, past `mobileVisibleCount`, an overflow popover — so a
   * `data-testid` baked into `label` lands in the DOM two or three times and
   * any strict-mode locator for it fails. Pass `testId` instead: it goes on
   * the desktop link only, which is the copy visible at the desktop viewports
   * the e2e suite runs at, so it resolves to exactly one element.
   */
  tabs?: {
    label: React.ReactNode;
    href: string;
    testId?: string;
    /**
     * Override URL matching for tabs that represent query-owned views — the
     * MCP registry's facets live in a search param, so only the caller knows
     * which one the URL means.
     *
     * This is *selection*: which tab the reader is currently on. It is not the
     * state of the thing the tab links to. A tab whose label carries a status
     * badge ("Active", "Configure") must leave this alone and let the URL
     * decide, or every connected channel renders as the open page at once.
     */
    selected?: boolean;
  }[];
  title: React.ReactNode;
  /**
   * Browser tab title, for pages whose visible `title` is composed markup (an
   * icon plus a name, say) rather than a plain string. Without it those pages
   * can't participate in the title sync below.
   */
  documentTitle?: string;
  /**
   * "Back to <parent>" control for a detail page, rendered above the title so
   * it reads as part of the header rather than as the first item of content.
   */
  backLink?: React.ReactNode;
  /** Omit on pages whose title needs no gloss — nothing is rendered. */
  description?: React.ReactNode;
  /**
   * The one pill saying what state this thing is in right now, beside the
   * title. For a state a runtime signal actually answers — an MCP server's
   * probe says whether it is reachable — and for nothing else. A pill that
   * every record on the page carries permanently ("Active" on every agent)
   * tells the reader nothing they did not already know from the page being
   * there, so it is left empty by default rather than filled with a constant.
   *
   * Colours come from `lib/design/status-tone.ts`; the caller renders the
   * pill, this only places it.
   */
  status?: React.ReactNode;
  actionButton?: React.ReactNode;
  mobileVisibleCount?: number;
  /**
   * The column the header row and the content share. `wide` is the band list
   * pages fill; `wizard` is the setup wizards' column, for a detail page that
   * opens into one — the column then stays put between reading and editing.
   */
  maxWidth?: keyof typeof MAX_WIDTH_CLASSES;
  /**
   * Floor for the shared header/content column. `phone` is 20rem — wide
   * enough to read body copy, narrow enough that a phone does not
   * horizontally scroll the whole page. Tables inside still scroll.
   */
  minWidth?: keyof typeof MIN_WIDTH_CLASSES;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const appName = useAppName();

  // Keep the browser tab title in sync with the page so screen reader and
  // switcher users can tell client-side navigated pages apart (WCAG 2.4.2).
  useEffect(() => {
    const pageTitle = documentTitle ?? (typeof title === "string" ? title : "");
    if (pageTitle && appName) {
      document.title = `${pageTitle} - ${appName}`;
    }
  }, [title, documentTitle, appName]);
  const currentUrl = searchParams.toString()
    ? `${pathname}?${searchParams.toString()}`
    : pathname;
  const maxWidth = MAX_WIDTH_CLASSES[maxWidthKey];
  const resolvedMinWidthKey =
    minWidthKey === "none" && maxWidthKey === "wizard" ? "phone" : minWidthKey;
  const minWidth = MIN_WIDTH_CLASSES[resolvedMinWidthKey];
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Split tabs for mobile: visible vs overflow
  const mobileVisibleTabs = tabs.slice(0, mobileVisibleCount);
  const mobileOverflowTabs = tabs.slice(mobileVisibleCount);

  // One winner, resolved once and shared by all three rows. `find` is what
  // makes the selected treatment — and `aria-current="page"` — exclusive: the
  // reader is on exactly one page, so at most one tab may claim to be it, no
  // matter what a caller passes in `selected`.
  const selectedTab = tabs.find(
    (tab) => tab.selected ?? isTabActive(currentUrl, tab.href, tabs),
  );
  const selectedOverflowTab =
    selectedTab && mobileOverflowTabs.includes(selectedTab)
      ? selectedTab
      : undefined;

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col">
      <div
        data-page-header
        className="border-b border-border bg-background md:sticky md:top-0 md:z-20"
      >
        <div className={cn("mx-auto", minWidth, maxWidth, "px-6 pt-6 md:px-6")}>
          {backLink && <div className="mb-2">{backLink}</div>}
          {/* Below sm the action buttons drop under the title/description
              instead of squeezing them into a sliver beside the buttons. */}
          <div
            className={cn(
              "mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
              maxWidthKey === "wizard" && "min-h-[5.75rem] sm:min-h-[3.75rem]",
            )}
          >
            <div
              className={cn(
                "min-w-0 sm:flex-1",
                maxWidthKey === "wizard" &&
                  "min-h-10 sm:relative sm:h-[3.75rem] sm:min-h-0",
              )}
            >
              {/* Sibling pages of a tabbed section render PageLayout at the
                  same tree position, so React reconciles it across
                  client-side navigations instead of remounting. A rich
                  description (text mixed with links, like the Costs page)
                  then has its bare text nodes deleted one by one when the
                  page changes — which crashes React once Chrome
                  page-translate has re-parented them into <font> wrappers
                  (facebook/react#11538). Keying the wrappers by pathname
                  swaps a whole element per page instead. */}
              {/* The status pill is a sibling of the heading, not part of it:
                  detail titles already compose an icon, a name and badges
                  inside `title`, and folding a live state into the accessible
                  heading name would make the heading change every time the
                  probe does. */}
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  maxWidthKey === "wizard"
                    ? "flex-nowrap overflow-hidden"
                    : "flex-wrap",
                  description && maxWidthKey !== "wizard" && "mb-2",
                )}
              >
                <h1
                  className={cn(
                    "min-w-0 text-2xl font-semibold tracking-tight",
                    maxWidthKey === "wizard" && "max-h-10 overflow-hidden",
                  )}
                >
                  <span key={pathname}>{title}</span>
                </h1>
                {status && <div className="shrink-0">{status}</div>}
              </div>
              {description && (
                <div
                  data-page-description
                  className={cn(
                    "text-sm text-muted-foreground",
                    maxWidthKey === "wizard" &&
                      "hidden sm:absolute sm:inset-x-0 sm:bottom-0 sm:line-clamp-1",
                  )}
                >
                  <span key={pathname}>{description}</span>
                </div>
              )}
            </div>
            {actionButton && <div className="shrink-0">{actionButton}</div>}
          </div>
          {tabs.length > 0 && (
            <>
              {/* Desktop: Show all tabs */}
              <div className="hidden md:flex gap-4 mb-0 overflow-x-auto whitespace-nowrap">
                {tabs.map((tab) => {
                  const isSelected = tab === selectedTab;
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      aria-current={isSelected ? "page" : undefined}
                      // Only this copy carries the test id — see the `tabs` prop.
                      data-testid={tab.testId}
                      className={cn(
                        "relative cursor-pointer pb-3 text-sm font-medium transition-colors hover:text-foreground",
                        isSelected
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {tab.label}
                      {isSelected && (
                        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                    </Link>
                  );
                })}
              </div>

              {/* Mobile: Show first N tabs + overflow dropdown */}
              <div className="flex md:hidden gap-3 mb-0 items-center whitespace-nowrap overflow-x-auto">
                {mobileVisibleTabs.map((tab) => {
                  const isSelected = tab === selectedTab;
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      aria-current={isSelected ? "page" : undefined}
                      className={cn(
                        "relative cursor-pointer pb-1 text-sm font-medium transition-colors hover:text-foreground",
                        isSelected
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {tab.label}
                      {isSelected && (
                        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                    </Link>
                  );
                })}

                {mobileOverflowTabs.length > 0 && (
                  <>
                    <div className="h-5 w-px bg-border shrink-0" />
                    <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            "relative h-auto cursor-pointer rounded-none px-1 pb-3 text-sm font-medium transition-colors hover:bg-transparent hover:text-foreground flex items-center gap-1",
                            selectedOverflowTab
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {/* Distinct keyed spans so switching between the
                              label (an element) and "More" (a string) swaps
                              elements instead of deleting a bare text node —
                              Chrome page-translate re-parents text nodes into
                              <font> wrappers and React crashes removing a
                              re-parented text node (facebook/react#11538). */}
                          {selectedOverflowTab ? (
                            <span key="selected-tab">
                              {selectedOverflowTab.label}
                            </span>
                          ) : (
                            <span key="more">More</span>
                          )}
                          <ChevronDown className="h-3.5 w-3.5" />
                          {selectedOverflowTab && (
                            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-auto p-1 flex flex-col"
                        align="end"
                      >
                        {mobileOverflowTabs.map((tab) => {
                          const isSelected = tab === selectedTab;
                          return (
                            <Link
                              key={tab.href}
                              href={tab.href}
                              aria-current={isSelected ? "page" : undefined}
                              onClick={() => setOverflowOpen(false)}
                              className={cn(
                                "cursor-pointer rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted",
                                isSelected
                                  ? "font-medium text-foreground bg-muted"
                                  : "text-muted-foreground",
                              )}
                            >
                              {tab.label}
                            </Link>
                          );
                        })}
                      </PopoverContent>
                    </Popover>
                  </>
                )}
              </div>
            </>
          )}
          {!tabs.length && <div className="mb-6" />}
        </div>
      </div>
      <div
        className={cn(
          "min-h-full w-full",
          minWidth && "min-w-0 overflow-x-auto",
        )}
      >
        <div
          className={cn(
            "mx-auto w-full",
            minWidth || "min-w-0",
            maxWidth,
            "px-6 py-6 md:px-6",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

const MIN_WIDTH_CLASSES = {
  none: "",
  phone: "min-w-[20rem]",
} as const;

const MAX_WIDTH_CLASSES = {
  wide: "max-w-[1680px]",
  // Wizard and detail pages share this exact header/content column. Padding
  // lives inside the band, so add it back for 5xl content-edge alignment.
  wizard: "max-w-[calc(var(--container-5xl)+3rem)]",
} as const;
