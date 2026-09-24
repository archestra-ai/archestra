"use client";

import { Layers } from "lucide-react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEffectivePolicy,
  usePolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { BATTERY_STATUS_BADGES } from "./policy-decorations";

/**
 * The composed document the runtime actually enforces: the organization's text
 * with every included battery's policy folded in. Read-only — the way to change
 * it is to change the text or the batteries it includes. A text the host
 * refused composes to nothing, so the document shown then is the last one that
 * opened, kept until a text composes again.
 */
export function EffectivePolicyView({ enabled }: { enabled: boolean }) {
  const effective = useEffectivePolicy(enabled);
  const declarations = usePolicyDeclarations();
  if (effective.isPending) return <Skeleton className="h-[65vh] w-full" />;
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
      className="overflow-hidden rounded-lg border bg-background"
      data-testid="effective-policy"
      data-refused={refused}
    >
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Layers className="size-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">
            {refused ? "Last composed policy" : "Effective policy"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {refused
              ? "The current text was refused and composes to nothing; this is the last document that opened."
              : "What the runtime enforces, batteries included."}
          </p>
        </div>
      </div>
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
                    ({BATTERY_STATUS_BADGES[battery.status].label.toLowerCase()}
                    )
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
          readOnly: true,
          ariaLabel: "Effective guardrails policy",
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 16, bottom: 16 },
          automaticLayout: true,
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
