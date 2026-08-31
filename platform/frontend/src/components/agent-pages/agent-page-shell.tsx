"use client";

import type { ReactNode } from "react";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";

/**
 * Shared agent-family wizard shell. It delegates all header, width, minimum
 * width, and content behavior to the same PageLayout used by detail pages.
 */
export function AgentPageShell({
  backHref,
  backLabel,
  onBackRequest,
  header,
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
  /** Structured header rendered by the same PageLayout as agent details. */
  header: {
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
  };
  children: ReactNode;
}) {
  return (
    <PageLayout
      maxWidth="wizard"
      minWidth="phone"
      title={header.title}
      description={header.description}
      actionButton={header.action}
      backLink={
        backHref ? (
          <PageBackLink href={backHref} onNavigate={onBackRequest}>
            {backLabel}
          </PageBackLink>
        ) : undefined
      }
    >
      {children}
    </PageLayout>
  );
}
