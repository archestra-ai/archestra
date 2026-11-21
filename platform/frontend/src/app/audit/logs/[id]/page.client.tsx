"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { formatAction } from "@/app/audit/logs/_parts/audit-log-action-labels";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuditLog } from "@/lib/audit-log/audit-log.query";
import { AuditEventChanges, AuditEventRaw } from "./_parts/audit-event-changes";
import {
  AuditEventFacts,
  AuditEventHeaderIcon,
  AuditEventIdentityLine,
} from "./_parts/audit-event-facts";

export function AuditEventDetailPage({ id }: { id: string }) {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <AuditEventDetail id={id} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const BACK_HREF = "/logs";

/**
 * One audit event on its own page: what happened and to what, how it went,
 * the request that carried it, then the change itself as a diff.
 */
function AuditEventDetail({ id }: { id: string }) {
  const { data: event, isPending, isLoadingError, refetch } = useAuditLog(id);

  // The header stays put through loading, failure and not-found, so the
  // reader always has a title and a way back.
  if (isPending) {
    return (
      <AuditEventShell>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      </AuditEventShell>
    );
  }

  if (isLoadingError) {
    return (
      <AuditEventShell>
        <QueryLoadError
          title="Couldn't load this audit event"
          onRetry={() => refetch()}
        />
      </AuditEventShell>
    );
  }

  if (!event) {
    return (
      <AuditEventShell>
        <div className="text-muted-foreground">Audit event not found</div>
      </AuditEventShell>
    );
  }

  const title = formatAction(event.action);

  return (
    <PageLayout
      denseContent
      icon={<AuditEventHeaderIcon event={event} />}
      title={title}
      documentTitle={title}
      stackHeaderOnMobile
      backLink={<PageBackLink href={BACK_HREF}>Back to Logs</PageBackLink>}
      description={<AuditEventIdentityLine event={event} />}
    >
      <div className="space-y-4">
        <AuditEventFacts event={event} />
        <AuditEventChanges event={event} />
        <AuditEventRaw event={event} />
      </div>
    </PageLayout>
  );
}

/** The page's header while there is no record to name it with. */
function AuditEventShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout
      denseContent
      title="Audit event"
      backLink={<PageBackLink href={BACK_HREF}>Back to Logs</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}
