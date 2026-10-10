"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useListReturnHref } from "@/lib/hooks/use-list-return-url";

/** Shared back control for every PageLayout detail and wizard header. */
export function PageBackLink({
  href,
  onNavigate,
  onClick,
  iconOnly = false,
  children,
}: {
  href: string;
  /** Just the arrow; `children` becomes its accessible name. */
  iconOnly?: boolean;
  onNavigate?: () => void;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children: ReactNode;
}) {
  const resolvedHref = useListReturnHref(href);
  return (
    <Button
      variant="ghost"
      size={iconOnly ? "icon-sm" : "sm"}
      className="-ml-2 shrink-0 text-muted-foreground"
      asChild
    >
      <Link
        href={resolvedHref}
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
        {iconOnly ? <span className="sr-only">{children}</span> : children}
      </Link>
    </Button>
  );
}
