"use client";

import Link from "next/link";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useEffectivePolicy,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { formatDate } from "@/lib/utils/date-time";
import { BATTERY_STATUS } from "./battery-status";
import { compositionOf } from "./composition-view";
import { PolicyPaneEditor, PolicyPaneSkeleton } from "./policy-source-pane";

/**
 * The composed document the runtime actually enforces: the organization's text
 * with every included battery's policy folded in. Read-only — the way to change
 * it is to change the text or the batteries it includes. A text the host
 * refused composes to nothing, so the document shown then is the earlier
 * composition the runtime keeps enforcing, or, when none ever opened, the
 * organization's text alone, which enforces nothing. Fills the height its
 * parent gives it.
 */
export function EffectivePolicyView() {
  const effective = useEffectivePolicy();
  const declarations = usePolicyDeclarations();
  if (effective.isPending)
    return <PolicyPaneSkeleton className="min-h-0 flex-1" />;
  if (effective.isError || !effective.data)
    return (
      <div className="p-3">
        <QueryLoadError
          title="Could not load the effective policy"
          error={effective.error}
          onRetry={() => effective.refetch()}
        />
      </div>
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
  const entryOf = (name: string) =>
    declarations.data?.batteries.find((battery) => battery.name === name)
      ?.entry ?? null;
  const state =
    served.kind === "current"
      ? "composed"
      : served.kind === "previous"
        ? "refused-serving-previous"
        : "refused-root-only";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="effective-policy"
      data-composition={state}
    >
      {stubs.length > 0 && (
        <div className="shrink-0 border-b px-3 py-2">
          <InlineNotice variant="warning" data-testid="effective-policy-stubs">
            <InlineNoticeText>
              <span>
                {stubs.length === 1
                  ? "One battery's rules are left out of this policy until it is set up: "
                  : `${stubs.length} batteries' rules are left out of this policy until they are set up: `}
              </span>
              {stubs.map((battery, index) => (
                <span key={battery.name}>
                  {index > 0 ? <span>, </span> : null}
                  {entryOf(battery.name) ? (
                    // Its file in the Source view says what it needs and fixes it.
                    <Link
                      href={`/openappa/policy?${new URLSearchParams({ entry: entryOf(battery.name) ?? "" })}`}
                      className="font-medium underline underline-offset-2"
                    >
                      {battery.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{battery.name}</span>
                  )}
                  <span>
                    {" "}
                    ({BATTERY_STATUS[battery.status].label.toLowerCase()})
                  </span>
                </span>
              ))}
              <span>. Open one to set it up.</span>
            </InlineNoticeText>
          </InlineNotice>
        </div>
      )}
      {lastError && (
        <div className="shrink-0 border-b px-3 py-2">
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
      <PolicyPaneEditor
        path="effective-policy.toml"
        content={content}
        ariaLabel="Effective guardrails policy"
        className="min-h-0 flex-1"
      />
      <div className="flex shrink-0 flex-wrap gap-x-4 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {served.kind === "current"
            ? `Built from policy revision ${rootRevision} · ${hash}`
            : served.kind === "root_only"
              ? `Revision ${rootRevision} refused · nothing enforced · ${hash}`
              : served.rootRevision === null
                ? `Revision ${rootRevision} refused · enforcing an earlier composition · ${hash}`
                : `Revision ${rootRevision} refused · enforcing revision ${served.rootRevision} · ${hash}`}
        </span>
        {effective.data.servedRevision && (
          // When the runtime took it up; its own revision counter is a detail.
          <span
            title={`Runtime revision ${effective.data.servedRevision.revision}`}
          >
            {`In force since ${formatDate({
              date: effective.data.servedRevision.publishedAt,
              dateFormat: "MM/dd HH:mm",
            })}`}
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
