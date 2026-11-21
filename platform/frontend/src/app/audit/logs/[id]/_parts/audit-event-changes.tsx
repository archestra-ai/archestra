"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
  AUDIT_DIFF_METADATA_KEYS,
  AuditLogDiffView,
  summarizeAuditDiffHints,
} from "@/app/audit/logs/_parts/audit-log-diff-view";
import { JsonCodeBlock } from "@/components/json-code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";

/**
 * What the event changed: the before/after snapshots as one unified diff,
 * under a line naming the kind of change and how many fields it touched.
 */
export function AuditEventChanges({ event }: { event: AuditLog }) {
  const before = (event.before ?? null) as Snapshot;
  const after = (event.after ?? null) as Snapshot;
  const count = useMemo(
    () => countChangedFields(before, after),
    [before, after],
  );
  const hint = summarizeAuditDiffHints(before, after);
  const kind =
    before === null && after === null
      ? null
      : before === null
        ? "Created"
        : after === null
          ? "Deleted"
          : "Updated";

  return (
    <DetailSection
      title="Changes"
      meta={
        kind ? (
          <span>
            {kind}
            {count > 0 ? (
              <span>
                {" "}
                · {count} {count === 1 ? "field" : "fields"}
              </span>
            ) : null}
          </span>
        ) : null
      }
    >
      <div className="space-y-2 p-4">
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        <AuditLogDiffView before={before} after={after} />
      </div>
    </DetailSection>
  );
}

/** The record exactly as the API returns it, folded away by default. */
export function AuditEventRaw({ event }: { event: AuditLog }) {
  return (
    <Collapsible className="group rounded-lg border bg-card">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-sm font-medium">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span>Raw event</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          JSON
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-4 pb-4">
        <JsonCodeBlock value={event} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type Snapshot = Record<string, unknown> | null;

function DetailSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)]"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {meta ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** Top-level fields that differ, ignoring timestamps — every field on a create or delete. */
function countChangedFields(before: Snapshot, after: Snapshot): number {
  if (before === null && after === null) return 0;
  if (before === null || after === null) {
    const snapshot = (before ?? after) as Record<string, unknown>;
    return Object.keys(snapshot).filter((k) => !AUDIT_DIFF_METADATA_KEYS.has(k))
      .length;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let count = 0;
  for (const key of keys) {
    if (AUDIT_DIFF_METADATA_KEYS.has(key)) continue;
    if (stableStringify(before[key]) !== stableStringify(after[key])) count++;
  }
  return count;
}

function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : v,
    ) ?? "undefined"
  );
}
