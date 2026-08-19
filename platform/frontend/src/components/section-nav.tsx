"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type SectionNavItem = {
  href: string;
  label: string;
  Icon?: LucideIcon;
};

/**
 * Vertical switcher for a settings surface's sections, sitting beside the
 * content rather than above it. Below `lg` it collapses to a scrollable row,
 * since a 15-entry column would push the content off the first screen.
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
      className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 lg:flex-col lg:overflow-visible"
    >
      {items.map(({ href, label: itemLabel, Icon }) => {
        const isActive = href === activeHref;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" />}
            {itemLabel}
          </Link>
        );
      })}
    </nav>
  );
}
