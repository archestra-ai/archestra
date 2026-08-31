"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Shared back control for every PageLayout detail and wizard header. */
export function PageBackLink({
  href,
  onNavigate,
  onClick,
  children,
}: {
  href: string;
  onNavigate?: () => void;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link
        href={href}
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
        {children}
      </Link>
    </Button>
  );
}
