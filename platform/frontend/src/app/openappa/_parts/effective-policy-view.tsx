"use client";

import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEffectivePolicy,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { BATTERY_STATUS } from "./battery-status";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";

/**
 * The composed document the runtime actually enforces: the organization's text
 * with every included battery's policy folded in. Read-only — the way to change
 * it is to change the text or the batteries it includes. A text the host
 * refused composes to nothing, so the document shown then is the last one that
 * opened, kept until a text composes again.
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
  const { content, contentHash, rootRevision, lastError } = effective.data;
  const refused = lastError !== null;
  const hash = contentHash.slice(0, 12);
  // A battery the host holds back folds in as the empty stub, which the
  // document itself does not show. Under a refusal every battery is out, so
  // the stubs are not listed twice.
  const stubs = refused
    ? []
    : (declarations.data?.batteries ?? []).filter(
        (battery) => !battery.composed,
      );
  return (
    <div
      className="overflow-hidden rounded-b-lg border bg-background"
      data-testid="effective-policy"
      data-refused={refused}
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
          <InlineNotice variant="error" data-testid="effective-policy-error">
            <span className="font-medium">
              The current text was refused and composes to nothing; this is the
              last document that opened.
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
          {refused
            ? `Revision ${rootRevision} refused · kept ${hash}`
            : `Composed from revision ${rootRevision} · ${hash}`}
        </span>
      </div>
    </div>
  );
}
