"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";

export type SectionNavItem = {
  href: string;
  label: string;
  Icon?: LucideIcon;
  /**
   * Pages inside this section, listed under it while it is the active one. A
   * component rather than data, so whatever it fetches (a status per page,
   * say) loads only on that section's pages.
   */
  subnav?: ReactNode;
};

/**
 * Vertical switcher for a settings surface's sections, sitting beside the
 * content rather than above it. Below `lg` it collapses to a scrollable row,
 * since a 15-entry column would push the content off the first screen; a
 * section's subnav shows only in the column, so the section must also offer
 * its own way between its pages at that width.
 *
 * Matching is left to the caller through `activeHref` — routed surfaces have
 * to resolve a nested path back to its section, while a single-route surface
 * only compares a query param.
 */
export function SectionNav({
  items,
  activeHref,
  label,
}: {
  items: SectionNavItem[];
  activeHref: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-0.5 lg:p-1 lg:flex-col lg:overflow-visible"
    >
      {items.map(({ href, label: itemLabel, Icon, subnav }) => {
        const isActive = href === activeHref;
        return (
          <Fragment key={href}>
            <Link
              href={href}
              aria-current={isActive && !subnav ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors lg:py-2",
                isActive && !subnav
                  ? "bg-accent font-medium text-accent-foreground"
                  : isActive
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {Icon && <Icon className="size-4 shrink-0" />}
              {itemLabel}
            </Link>
            {isActive && subnav && (
              <div className="hidden lg:block">{subnav}</div>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** One page inside a section, indented under it in {@link SectionNav}. */
export function SectionSubnavLink({
  href,
  active,
  icon,
  label,
  status,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  /** A short state for the page, shown as a dot with its text for readers. */
  status?: { label: string; ok: boolean };
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 whitespace-nowrap rounded-md py-1.5 pr-3 pl-9 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {status && (
        <span
          title={status.label}
          className={cn(
            "size-2 shrink-0 rounded-full",
            status.ok ? "bg-green-600" : "bg-muted-foreground/40",
          )}
        >
          <span className="sr-only">{status.label}</span>
        </span>
      )}
    </Link>
  );
}
