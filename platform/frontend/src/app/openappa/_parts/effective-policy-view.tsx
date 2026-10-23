"use client";

import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEffectivePolicy,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { formatDate } from "@/lib/utils/date-time";
import { BATTERY_STATUS } from "./battery-status";
import { compositionOf } from "./composition-view";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";

/**
 * The composed document the runtime actually enforces: the organization's text
 * with every included battery's policy folded in. Read-only — the way to change
 * it is to change the text or the batteries it includes. A text the host
 * refused composes to nothing, so the document shown then is the earlier
 * composition the runtime keeps enforcing, or, when none ever opened, the
 * organization's text alone, which enforces nothing.
 */
export function EffectivePolicyView() {
  const effective = useEffectivePolicy();
  const declarations = usePolicyDeclarations();
  if (effective.isPending)
    return <Skeleton className="h-[65vh] w-full rounded-t-none" />;
  if (effective.isError || !effective.data)
    return (
      <QueryLoadError
        title="Could not load the effective policy"
        error={effective.error}
        onRetry={() => effective.refetch()}
      />
    );
  const { content, contentHash, rootRevision, lastError } = effective.data;
  const { served, refusal } = compositionOf(effective.data);
  const hash = contentHash.slice(0, 12);
  // A battery the host holds back folds in as the empty stub, which the
  // document itself does not show. Under an earlier composition the stubs
  // are the ones it composed; the root text alone composes none.
  const stubs =
    served.kind === "current"
      ? (declarations.data?.batteries ?? []).flatMap((battery) =>
          battery.composed
            ? []
            : [{ name: battery.name, status: battery.status }],
        )
      : served.kind === "previous"
        ? (served.batteries ?? []).filter((battery) => !battery.composed)
        : [];
  const state =
    served.kind === "current"
      ? "composed"
      : served.kind === "previous"
        ? "refused-serving-previous"
        : "refused-root-only";
  return (
    <div
      className="overflow-hidden rounded-b-lg border bg-background"
      data-testid="effective-policy"
      data-composition={state}
    >
      {stubs.length > 0 && (
        <div className="border-b px-4 py-3">
          <InlineNotice variant="warning" data-testid="effective-policy-stubs">
            <InlineNoticeText>
              <span>Composed as empty stubs, their rules left out: </span>
              {stubs.map((battery, index) => (
                <span key={battery.name}>
                  {index > 0 ? <span>, </span> : null}
                  <span className="font-medium">{battery.name}</span>
                  <span>
                    {" "}
                    ({BATTERY_STATUS[battery.status].label.toLowerCase()})
                  </span>
                </span>
              ))}
              <span>.</span>
            </InlineNoticeText>
          </InlineNotice>
        </div>
      )}
      {lastError && (
        <div className="border-b px-4 py-3">
          <InlineNotice
            variant={served.kind === "root_only" ? "error" : "warning"}
            data-testid="effective-policy-error"
          >
            <span className="font-medium">
              {served.kind === "root_only"
                ? `${refused(refusal?.rootRevision ?? null)} was refused and no composition opened before it. This is the organization's text alone, which the runtime cannot open, so governed calls are refused.`
                : served.kind === "previous" && served.rootRevision !== null
                  ? `${refused(refusal?.rootRevision ?? null)} was refused. The runtime still enforces this document, composed from revision ${served.rootRevision}.`
                  : `${refused(refusal?.rootRevision ?? null)} was refused. The runtime still enforces this document, the last one that opened.`}
            </span>
            <InlineNoticeText className="whitespace-pre-wrap font-mono">
              {lastError}
            </InlineNoticeText>
          </InlineNotice>
        </div>
      )}
      <Editor
        height="min(50vh, 560px)"
        language="ini"
        value={content}
        options={{
          ...POLICY_EDITOR_OPTIONS,
          readOnly: true,
          ariaLabel: "Effective guardrails policy",
        }}
      />
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">
        <span>
          {served.kind === "current"
            ? `Composed from revision ${rootRevision} · ${hash}`
            : served.kind === "root_only"
              ? `Revision ${rootRevision} refused · nothing enforced · ${hash}`
              : served.rootRevision === null
                ? `Revision ${rootRevision} refused · enforcing an earlier composition · ${hash}`
                : `Revision ${rootRevision} refused · enforcing revision ${served.rootRevision} · ${hash}`}
        </span>
        {effective.data.servedRevision && (
          <span className="block">
            {`Runtime revision ${effective.data.servedRevision.revision} · published ${formatDate(
              {
                date: effective.data.servedRevision.publishedAt,
                dateFormat: "MM/dd HH:mm",
              },
            )} · open conversations follow it`}
          </span>
        )}
      </div>
    </div>
  );
}

/** How a refused attempt is named: its revision, or the latest one for a row marked stale. */
function refused(revision: number | null): string {
  return revision === null ? "The latest revision" : `Revision ${revision}`;
}
