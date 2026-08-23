"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Column for the create/edit wizard pages: the padded band the app layout
 * would otherwise give a list page, a back link, and a max-width column. The
 * detail page renders `PageLayout` instead, whose header band spans the full
 * width.
 */
export function AgentPageShell({
  backHref,
  backLabel,
  onBackRequest,
  children,
}: {
  /** Left unset for a state with nowhere to go back to; no link is rendered. */
  backHref?: string;
  backLabel: string;
  /**
   * Takes over the back link's navigation, so a page with an unsaved-changes
   * guard can ask before leaving. Omit it and the link navigates directly.
   */
  onBackRequest?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full px-6 py-6 md:px-6">
      <div className="mx-auto max-w-5xl space-y-6">
        {backHref && (
          <BackLink href={backHref} onNavigate={onBackRequest}>
            {backLabel}
          </BackLink>
        )}
        {children}
      </div>
    </div>
  );
}

export function BackLink({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate?: () => void;
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
          // A modified click opens the target elsewhere and leaves this page
          // (and its unsaved edits) standing, so let the browser have it.
          if (
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
