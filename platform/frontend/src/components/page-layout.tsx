"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  description,
  children,
  tabs = [],
  actionButton,
  mobileVisibleCount = 3,
}: {
  children: React.ReactNode;
  tabs?: { label: string; href: string }[];
  title: React.ReactNode;
  description: React.ReactNode;
  actionButton?: React.ReactNode;
  mobileVisibleCount?: number;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
          <div className="flex justify-between items-start sm:flex-row sm:justify-between sm:items-start">
            <h1 className="mb-2 text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {actionButton}
          </div>
          <div className="text-sm text-muted-foreground mb-6">
            {description}
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
                      className={cn(
                        "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
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
                      className={cn(
                        "relative pb-1 text-sm font-medium transition-colors hover:text-foreground",
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
                            "relative pb-3 px-1 h-auto rounded-none text-sm font-medium transition-colors hover:text-foreground hover:bg-transparent flex items-center gap-1",
                            activeOverflowTab
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {activeOverflowTab ? activeOverflowTab.label : "More"}
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
                              onClick={() => setOverflowOpen(false)}
                              className={cn(
                                "px-3 py-2 text-sm rounded-md transition-colors hover:bg-muted",
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
