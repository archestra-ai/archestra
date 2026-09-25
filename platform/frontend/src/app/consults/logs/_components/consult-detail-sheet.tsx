"use client";

import { Check, ChevronRight, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { JsonCodeBlock } from "@/components/json-code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn, formatDate } from "@/lib/utils";
import type {
  ConsultDiagnostics,
  ConsultView,
  JevChoiceLabel,
  JevCutoffLabel,
  JevDiagnostics,
} from "./consult-details";
import { ConsultOutcomeBadge } from "./consult-outcome-badge";

export function ConsultDetailSheet({
  view,
  onClose,
}: {
  view: ConsultView | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={view !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {view && <ConsultDetail view={view} />}
      </SheetContent>
    </Sheet>
  );
}

// === Internal components ===

function ConsultDetail({ view }: { view: ConsultView }) {
  const { consult, toolCall, diagnostics } = view;
  // The server nulls the request of an audience-source consult for callers
  // without member:read.
  const withheld = consult.request === null;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 font-mono text-base">
          <span>{consult.externalName}</span>
          <ConsultOutcomeBadge outcome={consult.outcome} />
        </SheetTitle>
        <SheetDescription>
          {formatDate({
            date: consult.createdAt,
            dateFormat: "MMM d, yyyy · HH:mm:ss",
          })}{" "}
          · {consult.durationMs} ms · {consult.role} via {consult.backend}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-6 px-4 pb-6">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <MetaRow label="Session" value={consult.sessionId} />
          <MetaRow label="Root" value={consult.root} />
          <MetaRow label="Trajectory" value={consult.trajectory} />
          <MetaRow label="Call" value={consult.callId} />
          <MetaRow label="HTTP status" value={consult.httpStatus} />
        </dl>

        {withheld ? (
          <InlineNotice variant="neutral">
            <EyeOff className="size-4" />
            <span className="font-medium">Withheld</span>
            <InlineNoticeText>
              This consult names people; viewing it requires member access.
            </InlineNoticeText>
          </InlineNotice>
        ) : (
          <>
            <Section title={toolCall ? `Tool: ${toolCall.name}` : "Request"}>
              <JsonCodeBlock
                value={toolCall ? toolCall.arguments : consult.request}
                maxHeightClassName="max-h-[320px] overflow-auto"
              />
            </Section>
            <Section title="Answer">
              {consult.answer === null ? (
                <p className="text-sm text-muted-foreground">No answer.</p>
              ) : (
                <JsonCodeBlock
                  value={consult.answer}
                  maxHeightClassName="max-h-[240px] overflow-auto"
                />
              )}
            </Section>
            <Section title="Diagnostics">
              {consult.diagnosticsTruncated && (
                <p className="mb-2 text-xs text-muted-foreground">
                  Truncated by the runtime.
                </p>
              )}
              <DiagnosticsView diagnostics={diagnostics} />
            </Section>
          </>
        )}

        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            <span>Raw JSON</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
            <JsonCodeBlock value={consult} />
            {view.rawResponse !== null && (
              <Section title="Raw response">
                <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-xs">
                  {view.rawResponse}
                </pre>
              </Section>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}

function DiagnosticsView({ diagnostics }: { diagnostics: ConsultDiagnostics }) {
  switch (diagnostics.kind) {
    case "none":
      return <p className="text-sm text-muted-foreground">None recorded.</p>;
    case "jev":
      return <JevDiagnosticsView jev={diagnostics.jev} />;
    case "json":
      return <JsonCodeBlock value={diagnostics.value} />;
    case "text":
      return (
        <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-xs">
          {diagnostics.text}
        </pre>
      );
  }
}

function JevDiagnosticsView({ jev }: { jev: JevDiagnostics }) {
  const { labels } = jev;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {jev.model} · {jev.elapsed_ms} ms · attempts: {jev.attempts.join(", ")}
        {jev.error && <span> · error: {jev.error}</span>}
      </p>
      {labels.delta_audience && (
        <ChoiceBars name="delta_audience" label={labels.delta_audience} />
      )}
      {labels.delta_trust && (
        <ChoiceBars name="delta_trust" label={labels.delta_trust} />
      )}
      {labels.requires_audience && (
        <ChoiceBars name="requires_audience" label={labels.requires_audience} />
      )}
      {labels.requires_trusted && (
        <CutoffBar name="requires_trusted" label={labels.requires_trusted} />
      )}
    </div>
  );
}

function ChoiceBars({ name, label }: { name: string; label: JevChoiceLabel }) {
  return (
    <LabelBlock name={name} decision={label.decision}>
      {label.probabilities.map(({ option, probability }) => (
        <ProbabilityRow
          key={option}
          option={option}
          probability={probability}
          chosen={option === label.decision}
        />
      ))}
    </LabelBlock>
  );
}

function CutoffBar({ name, label }: { name: string; label: JevCutoffLabel }) {
  const decision =
    label.decision === undefined ? undefined : String(label.decision);
  return (
    <LabelBlock name={name} decision={decision}>
      {label.probability === null ? (
        <p className="text-xs text-muted-foreground">No probability.</p>
      ) : (
        <ProbabilityRow
          option={`p ≥ ${label.threshold}`}
          probability={label.probability}
          chosen={label.decision === true}
          threshold={label.threshold}
        />
      )}
    </LabelBlock>
  );
}

function LabelBlock({
  name,
  decision,
  children,
}: {
  name: string;
  decision: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {decision === undefined ? "undecided" : `→ ${decision}`}
        </span>
      </div>
      {children}
    </div>
  );
}

function ProbabilityRow({
  option,
  probability,
  chosen,
  threshold,
}: {
  option: string;
  probability: number;
  chosen: boolean;
  threshold?: number;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-xs">
      <span
        className={cn(
          "flex items-center gap-1 truncate",
          chosen ? "font-medium" : "text-muted-foreground",
        )}
      >
        {chosen && <Check className="size-3" />}
        <span className="truncate">{option}</span>
      </span>
      <div className="relative">
        <Progress
          value={toPercent(probability)}
          className={cn(
            !chosen && "[&>[data-slot=progress-indicator]]:bg-primary/40",
          )}
        />
        {threshold !== undefined && (
          <div
            className="absolute -top-0.5 h-3 w-px bg-foreground"
            style={{ left: `${toPercent(threshold)}%` }}
          />
        )}
      </div>
      <span className="text-right tabular-nums">
        {(probability * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs leading-5">{value ?? "—"}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

// Jev may answer outside [0, 1]; the bar clamps, the printed value stays raw.
function toPercent(probability: number): number {
  return Math.min(100, Math.max(0, probability * 100));
}
