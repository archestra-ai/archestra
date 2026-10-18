"use client";

import { ArrowLeft, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ConsultPayloads } from "@/app/consults/logs/_components/consult-detail-sheet";
import type { ConsultView } from "@/app/consults/logs/_components/consult-details";
import { ConsultOutcomeBadge } from "@/app/consults/logs/_components/consult-outcome-badge";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils/date-time";
import {
  OVERVIEW_GRID,
  OverviewCell,
  OverviewSection,
  paneHeight,
} from "./overview-parts";

/**
 * A guardrail consult in the session's details pane, laid out like a tool
 * call's: the facts on the left, what the policy asked the external and what
 * it answered on the right. The same record the Guardrail consults log
 * shows, reached from the trace instead.
 */
export function ConsultDetails({
  height,
  view,
  toolName,
  when,
  verdict,
  onBack,
}: {
  /** The resizable pane height, applied from `lg`. */
  height: number;
  view: ConsultView;
  /** The tool call the consult was raised for, when there was one. */
  toolName: string | null;
  /** "Before the call" or "On the result". */
  when: string | null;
  /** What the policy made of the answer, when known. */
  verdict?: ReactNode;
  /** Back to the tool call (or request) the consult belongs to. */
  onBack: (() => void) | null;
}) {
  const { consult } = view;
  return (
    <section
      aria-label="Guardrail consult details"
      className="flex flex-col border-t lg:grid lg:h-[var(--pane-h)] lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden lg:border-t-0"
      style={paneHeight(height)}
    >
      <aside
        aria-label="Guardrail consult overview"
        className="flex min-w-0 flex-col border-b bg-muted/25 lg:min-h-0 lg:border-r lg:border-b-0"
      >
        <PaneHeader>
          {onBack ? (
            <Button
              variant="ghost"
              size="xs"
              className="-ml-2 gap-1 px-1.5 text-muted-foreground hover:text-foreground"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
              <span className="max-w-[18ch] truncate font-mono">
                {toolName ?? "Back"}
              </span>
            </Button>
          ) : null}
          <span className="ml-auto text-xs font-medium">Guardrail check</span>
        </PaneHeader>

        <div className="divide-y divide-border/60 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <OverviewSection>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-300">
                <ShieldCheck className="size-3" aria-hidden="true" />
              </span>
              <span
                className="min-w-0 truncate font-mono text-sm font-medium"
                title={consult.externalName}
              >
                {consult.externalName}
              </span>
              <span className="ml-auto shrink-0">
                <ConsultOutcomeBadge outcome={consult.outcome} />
              </span>
            </div>
            {verdict ? <div className="mt-2 text-xs">{verdict}</div> : null}
          </OverviewSection>

          <OverviewSection title="Check">
            <dl className={OVERVIEW_GRID}>
              <OverviewCell label="Role">
                {ROLE_LABELS[consult.role] ?? consult.role}
              </OverviewCell>
              <OverviewCell label="Backend">{consult.backend}</OverviewCell>
              {toolName ? (
                <OverviewCell label="Tool" className="col-span-2">
                  <span className="font-mono">{toolName}</span>
                  {when ? (
                    <span className="text-muted-foreground"> · {when}</span>
                  ) : null}
                </OverviewCell>
              ) : null}
            </dl>
          </OverviewSection>

          <OverviewSection title="Timing">
            <dl className={OVERVIEW_GRID}>
              <OverviewCell label="Started">
                {formatDate({
                  date: consult.startedAt,
                  dateFormat: "HH:mm:ss",
                })}
              </OverviewCell>
              <OverviewCell label="Duration">
                {formatConsultDuration(consult.durationMs)}
              </OverviewCell>
              {consult.httpStatus != null ? (
                <OverviewCell label="HTTP status">
                  {consult.httpStatus}
                </OverviewCell>
              ) : null}
            </dl>
          </OverviewSection>

          <OverviewSection title="Trajectory">
            <dl className="grid gap-y-1.5">
              <OverviewCell label="Session">
                <span className="font-mono" title={consult.sessionId ?? ""}>
                  {consult.sessionId ?? "—"}
                </span>
              </OverviewCell>
              <OverviewCell label="Call">
                <span className="font-mono" title={consult.callId ?? ""}>
                  {consult.callId ?? "—"}
                </span>
              </OverviewCell>
            </dl>
          </OverviewSection>
        </div>
      </aside>

      <section
        aria-label="Request and answer"
        className="flex min-w-0 flex-col lg:min-h-0"
      >
        <PaneHeader>
          <span className="text-xs font-medium">Request and answer</span>
        </PaneHeader>
        <div className="px-4 pt-2 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <ConsultPayloads view={view} />
        </div>
      </section>
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const ROLE_LABELS: Record<string, string> = {
  authority: "Authority",
  annotator: "Annotator",
  sanitizer: "Sanitizer",
  audience_source: "Audience source",
};

function formatConsultDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
