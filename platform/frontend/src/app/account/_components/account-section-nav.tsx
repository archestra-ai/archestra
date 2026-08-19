"use client";

import Link from "next/link";
import {
  type AccountSectionId,
  accountSections,
} from "@/app/account/_components/account-sections";
import { cn } from "@/lib/utils";

/**
 * Vertical section switcher for the account page. Each entry is a real link to
 * `?section=<id>` so sections are deep-linkable and survive back/forward; the
 * link deliberately drops any other query params, so a `?highlight=` deep link
 * doesn't re-fire its dialog once the reader moves to another section.
 */
export function AccountSectionNav({
  activeSection,
}: {
  activeSection: AccountSectionId;
}) {
  return (
    <nav
      aria-label="Personal settings sections"
      className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 lg:flex-col lg:overflow-visible"
    >
      {accountSections.map(({ id, label, Icon }) => {
        const isActive = id === activeSection;
        return (
          <Link
            key={id}
            href={`/account?section=${id}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
