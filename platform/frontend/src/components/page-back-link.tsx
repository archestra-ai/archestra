"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useListReturnHref } from "@/lib/hooks/use-list-return-url";

/**
 * Shared back control for every PageLayout detail and wizard header: an arrow
 * beside the title. `children` names the destination — it stays the link's
 * accessible name and, when it is a string, its hover tooltip.
 */
export function PageBackLink({
  href,
  onNavigate,
  onClick,
  labelled = false,
  children,
}: {
  href: string;
  /**
   * Show `children` beside the arrow. Only for a back link placed in page
   * content rather than in the PageLayout header's title row.
   */
  labelled?: boolean;
  onNavigate?: () => void;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children: ReactNode;
}) {
  const resolvedHref = useListReturnHref(href);
  return (
    <Button
      variant="ghost"
      size={labelled ? "sm" : "icon-sm"}
      className="-ml-2 shrink-0 text-muted-foreground"
      asChild
    >
      <Link
        href={resolvedHref}
        title={!labelled && typeof children === "string" ? children : undefined}
        onClick={(event) => {
          onClick?.(event);
          if (
            event.defaultPrevented ||
            !onNavigate ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          onNavigate();
        }}
      >
        <ArrowLeft className="h-4 w-4" />
        {labelled ? children : <span className="sr-only">{children}</span>}
      </Link>
    </Button>
  );
}
