"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  AgentIcon,
  agentLabel,
} from "@/app/connections/logs/_parts/agent-icon";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ConnectionEventFacts,
  ConnectionIdentityLine,
  ConnectionRecentActivity,
  connectionClient,
  describeConnectionAction,
} from "./_parts/connection-event-details";
import { useConnectionEvent } from "./_parts/use-connection-event";

export function ConnectionEventDetailPage({ id }: { id: string }) {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <ConnectionEventDetail id={id} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const BACK_HREF = "/logs";

/**
 * One agent connection event: which client did what, for whom and against
 * which gateway, then that member's other events from the same client.
 */
function ConnectionEventDetail({ id }: { id: string }) {
  const { event, recent, recentPending, isPending, isLoadingError, refetch } =
    useConnectionEvent(id);

  if (isPending) {
    return (
      <ConnectionEventShell>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      </ConnectionEventShell>
    );
  }

  if (isLoadingError) {
    return (
      <ConnectionEventShell>
        <QueryLoadError
          title="Couldn't load this connection event"
          onRetry={() => refetch()}
        />
      </ConnectionEventShell>
    );
  }

  if (!event) {
    return (
      <ConnectionEventShell>
        <div className="text-muted-foreground">Connection event not found</div>
      </ConnectionEventShell>
    );
  }

  const client = connectionClient(event);
  const title = `${agentLabel(client)} ${describeConnectionAction(event).phrase}`;

  return (
    <PageLayout
      denseContent
      icon={<AgentIcon agent={client} size={24} />}
      title={title}
      documentTitle={title}
      stackHeaderOnMobile
      backLink={<PageBackLink href={BACK_HREF}>Back to Logs</PageBackLink>}
      description={<ConnectionIdentityLine event={event} />}
    >
      <div className="space-y-4">
        <ConnectionEventFacts event={event} />
        <ConnectionRecentActivity
          event={event}
          recent={recent}
          pending={recentPending}
        />
      </div>
    </PageLayout>
  );
}

/** The page's header while there is no record to name it with. */
function ConnectionEventShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout
      denseContent
      title="Connection event"
      backLink={<PageBackLink href={BACK_HREF}>Back to Logs</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}
