"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { toConsultView } from "@/app/consults/logs/_components/consult-details";
import { ConsultOutcomeBadge } from "@/app/consults/logs/_components/consult-outcome-badge";
import { ConsultDetails } from "@/app/llm/logs/[id]/_parts/consult-details";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { llmSessionConsultHref } from "@/lib/interactions/llm-log-links";
import {
  type ExternalConsult,
  useExternalConsult,
} from "@/lib/openappa/external-consults.query";
import { formatDate } from "@/lib/utils/date-time";

export function ConsultDetailPage({ id }: { id: string }) {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <ConsultDetail id={id} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * One guardrail consult. A consult raised in a logged LLM session opens on
 * that session's trace, where it sits beside the tool call it was about; one
 * with no logged session (or tool call outside the logs) gets this slimmer
 * page: its facts, then the same details pane the trace shows.
 */
function ConsultDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, isPending, isLoadingError, refetch } = useExternalConsult(id);
  const sessionHref = data?.llmSessionId
    ? llmSessionConsultHref({
        sessionKey: data.llmSessionId,
        consultId: data.consult.id,
        mcpToolCallId: data.mcpToolCallId,
      })
    : null;

  useEffect(() => {
    if (sessionHref) router.replace(sessionHref);
  }, [sessionHref, router]);

  if (isPending || sessionHref) {
    return (
      <ConsultShell>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      </ConsultShell>
    );
  }

  if (isLoadingError) {
    return (
      <ConsultShell>
        <QueryLoadError
          title="Couldn't load this consult"
          onRetry={() => refetch()}
        />
      </ConsultShell>
    );
  }

  if (!data) {
    return (
      <ConsultShell>
        <div className="text-muted-foreground">Consult not found</div>
      </ConsultShell>
    );
  }

  const { consult } = data;
  const view = toConsultView(consult);
  return (
    <PageLayout
      denseContent
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{consult.externalName}</span>
          <span className="flex translate-y-px">
            <ConsultOutcomeBadge outcome={consult.outcome} />
          </span>
        </span>
      }
      documentTitle={consult.externalName}
      stackHeaderOnMobile
      backLink={
        <PageBackLink href="/consults/logs">
          Back to Guardrail consults
        </PageBackLink>
      }
      description="Not part of a logged LLM session, so it has no trace to open in."
    >
      <div className="space-y-4">
        <ConsultFacts consult={consult} />
        <section
          aria-label="Consult"
          className="overflow-clip rounded-lg border bg-card lg:overflow-hidden"
        >
          <ConsultDetails
            height={520}
            view={view}
            toolName={view.toolCall?.name ?? null}
            when={null}
            onBack={null}
          />
        </section>
      </div>
    </PageLayout>
  );
}

function ConsultFacts({ consult }: { consult: ExternalConsult }) {
  // OpenAPPA scopes the client's session id by caller: `<caller>|<session>`.
  const session = consult.sessionId?.slice(consult.sessionId.indexOf("|") + 1);
  return (
    <FactsStrip label="Consult facts">
      <Fact label="Started">
        <FactValue>
          {formatDate({
            date: consult.startedAt,
            dateFormat: "MMM d, HH:mm:ss",
          })}
        </FactValue>
        <FactSub>
          {consult.durationMs < 1000
            ? `${consult.durationMs}ms`
            : `${(consult.durationMs / 1000).toFixed(2)}s`}
        </FactSub>
      </Fact>
      <Fact label="Role">
        <FactValue>{ROLE_LABELS[consult.role] ?? consult.role}</FactValue>
        <FactSub>via {consult.backend}</FactSub>
      </Fact>
      <Fact label="Session">
        <FactValue>
          <span className="truncate font-mono text-sm" title={session ?? ""}>
            {session ?? "—"}
          </span>
        </FactValue>
        <FactSub>
          <span className="truncate" title={consult.callerId ?? ""}>
            {consult.callerId ?? "No caller"}
          </span>
        </FactSub>
      </Fact>
    </FactsStrip>
  );
}

/** The page's header while there is no record to name it with. */
function ConsultShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout
      denseContent
      title="Consult"
      backLink={
        <PageBackLink href="/consults/logs">
          Back to Guardrail consults
        </PageBackLink>
      }
    >
      {children}
    </PageLayout>
  );
}

const ROLE_LABELS: Record<string, string> = {
  authority: "Authority",
  annotator: "Annotator",
  sanitizer: "Sanitizer",
  audience_source: "Audience source",
  input: "Input",
  context_provider: "Context provider",
};
