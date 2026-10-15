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
        onRetry={() => effective.refetch()}
      />
    );
  const { content, contentHash, rootRevision, lastError, retained } =
    effective.data;
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
      {retained &&
        served.kind !== "root_only" &&
        (retained.kept.length > 0 || retained.inactive.length > 0) && (
          <div className="border-b px-4 py-3">
            <InlineNotice
              variant="info"
              data-testid="effective-policy-retained"
            >
              <span className="font-medium">{retainedTitle(retained)}</span>
              <InlineNoticeText>
                {retained.kept.map((annotator) => (
                  <span key={annotator.name} className="block">
                    {keptLine(annotator, retained.horizonDays)}
                  </span>
                ))}
                {retained.inactive.length > 0 && (
                  <span className="block">{inactiveLine(retained)}</span>
                )}
                {!retained.livenessKnown && (
                  <span className="block">
                    Conversation activity could not be read, so each is kept
                    until the next check.
                  </span>
                )}
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
      </div>
    </div>
  );
}

/** How a refused attempt is named: its revision, or the latest one for a row marked stale. */
function refused(revision: number | null): string {
  return revision === null ? "The latest revision" : `Revision ${revision}`;
}

/** One kept annotator: what answers it, who still needs it, and until when. */
function keptLine(
  annotator: {
    name: string;
    binding: string;
    liveRoots: number;
    retiresAt: string | null;
  },
  horizonDays: number,
): string {
  const conversations =
    annotator.liveRoots === 1
      ? "1 active conversation"
      : `${annotator.liveRoots} active conversations`;
  const until =
    horizonDays === 0
      ? "kept while a policy that needs it is stored"
      : annotator.retiresAt
        ? `kept until ${formatDate({ date: annotator.retiresAt, dateFormat: "MMM d, yyyy" })} unless one is active again`
        : "kept until activity can be read";
  return `${annotator.name} (${annotator.binding}): ${conversations}, ${until}.`;
}

type Retained = {
  horizonDays: number;
  kept: unknown[];
  inactive: { name: string }[];
};

function retainedTitle(retained: Retained): string {
  return retained.kept.length > 0
    ? "Kept for conversations that started under an earlier policy"
    : "No longer kept for earlier conversations";
}

/** The annotators no conversation needed within the horizon. */
function inactiveLine(retained: Retained): string {
  const names = retained.inactive.map(({ name }) => name).join(", ");
  const lead = retained.kept.length > 0 ? "No longer kept: " : "";
  return `${lead}${names}, unused by any conversation for ${retained.horizonDays} days.`;
}
