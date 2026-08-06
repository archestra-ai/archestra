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

// Helper to determine if a tab is active
// Sort tabs by href length descending so we match the most specific first
function isTabActive(
  currentUrl: string,
  tabHref: string,
  allTabs: { href: string }[],
) {
  // Sort tabs by href length (longest first)
  const sortedTabs = [...allTabs].sort((a, b) => b.href.length - a.href.length);

  // Find the first tab that matches
  for (const tab of sortedTabs) {
    if (currentUrl === tab.href || currentUrl.startsWith(`${tab.href}/`)) {
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
  children,
  tabs = [],
  actionButton,
  mobileVisibleCount = 3,
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
  tabs?: { label: React.ReactNode; href: string; testId?: string }[];
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
  description: React.ReactNode;
  actionButton?: React.ReactNode;
  mobileVisibleCount?: number;
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
  const maxWidth = "max-w-[1680px]";
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Split tabs for mobile: visible vs overflow
  const mobileVisibleTabs = tabs.slice(0, mobileVisibleCount);
  const mobileOverflowTabs = tabs.slice(mobileVisibleCount);

  // Check if the active tab is in the overflow
  const activeOverflowTab = mobileOverflowTabs.find((tab) =>
    isTabActive(pathname, tab.href, tabs),
  );

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className={cn("mx-auto", maxWidth, "px-6 pt-6 md:px-6")}>
          {backLink && <div className="mb-2">{backLink}</div>}
          {/* Below sm the action buttons drop under the title/description
              instead of squeezing them into a sliver beside the buttons. */}
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 sm:flex-1">
              {/* Sibling pages of a tabbed section render PageLayout at the
                  same tree position, so React reconciles it across
                  client-side navigations instead of remounting. A rich
                  description (text mixed with links, like the Costs page)
                  then has its bare text nodes deleted one by one when the
                  page changes — which crashes React once Chrome
                  page-translate has re-parented them into <font> wrappers
                  (facebook/react#11538). Keying the wrappers by pathname
                  swaps a whole element per page instead. */}
              <h1 className="mb-2 text-2xl font-semibold tracking-tight">
                <span key={pathname}>{title}</span>
              </h1>
              <div className="text-sm text-muted-foreground">
                <span key={pathname}>{description}</span>
              </div>
            </div>
            {actionButton && <div className="shrink-0">{actionButton}</div>}
          </div>
          {tabs.length > 0 && (
            <>
              {/* Desktop: Show all tabs */}
              <div className="hidden md:flex gap-4 mb-0 overflow-x-auto whitespace-nowrap">
                {tabs.map((tab) => {
                  const isActive = isTabActive(currentUrl, tab.href, tabs);
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      aria-current={isActive ? "page" : undefined}
                      // Only this copy carries the test id — see the `tabs` prop.
                      data-testid={tab.testId}
                      className={cn(
                        "relative cursor-pointer pb-3 text-sm font-medium transition-colors hover:text-foreground",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {tab.label}
                      {isActive && (
                        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                    </Link>
                  );
                })}
              </div>

              {/* Mobile: Show first N tabs + overflow dropdown */}
              <div className="flex md:hidden gap-3 mb-0 items-center whitespace-nowrap overflow-x-auto">
                {mobileVisibleTabs.map((tab) => {
                  const isActive = isTabActive(currentUrl, tab.href, tabs);
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative cursor-pointer pb-1 text-sm font-medium transition-colors hover:text-foreground",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {tab.label}
                      {isActive && (
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
                            activeOverflowTab
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
                          {activeOverflowTab ? (
                            <span key="active-tab">
                              {activeOverflowTab.label}
                            </span>
                          ) : (
                            <span key="more">More</span>
                          )}
                          <ChevronDown className="h-3.5 w-3.5" />
                          {activeOverflowTab && (
                            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-auto p-1 flex flex-col"
                        align="end"
                      >
                        {mobileOverflowTabs.map((tab) => {
                          const isActive = isTabActive(
                            currentUrl,
                            tab.href,
                            tabs,
                          );
                          return (
                            <Link
                              key={tab.href}
                              href={tab.href}
                              aria-current={isActive ? "page" : undefined}
                              onClick={() => setOverflowOpen(false)}
                              className={cn(
                                "cursor-pointer rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted",
                                isActive
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
      <div className="w-full h-full">
        <div className={cn("mx-auto w-full", maxWidth, "px-6 py-6 md:px-6")}>
          {children}
        </div>
      </div>
    </div>
  );
}
