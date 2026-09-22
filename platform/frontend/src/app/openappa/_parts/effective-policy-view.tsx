"use client";

import { Layers } from "lucide-react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffectivePolicy } from "@/lib/openappa-batteries.query";

/**
 * The composed document the runtime actually enforces: the organization's text
 * with every included battery's policy folded in. Read-only — the way to change
 * it is to change the text or the batteries it includes.
 */
export function EffectivePolicyView({ enabled }: { enabled: boolean }) {
  const effective = useEffectivePolicy(enabled);
  if (effective.isPending) return <Skeleton className="h-[65vh] w-full" />;
  if (effective.isError || !effective.data)
    return (
      <QueryLoadError
        title="Could not load the effective policy"
        onRetry={() => effective.refetch()}
      />
    );
  const { content, contentHash, rootRevision, lastError } = effective.data;
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Layers className="size-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">Effective policy</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What the runtime enforces, batteries included.
          </p>
        </div>
      </div>
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
        <span>{`Composed from revision ${rootRevision} · ${contentHash.slice(0, 12)}`}</span>
      </div>
    </div>
  );
}
