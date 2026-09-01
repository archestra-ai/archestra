import type { ReactNode } from "react";
import { typeRole } from "@/lib/design/type-scale";
import { cn } from "@/lib/utils";

/** One `label` over `value` pair in a {@link DetailFacts} row. */
export interface DetailFact {
  /** Doubles as the React key, so two facts in a row may not share a label. */
  label: string;
  value: ReactNode;
}

/**
 * The facts a detail page states about its record, on one wrapping row.
 *
 * This is the row {@link OverviewSummary} boxes for entity pages; the log and
 * connector detail pages render it bare under their header, where the facts
 * belong to the record's identity rather than to a section of the body. It
 * replaced a `MetadataCard` that put them in a bordered box under the heading
 * "Metadata" — a heading that names the shape of the content rather than any
 * of it, and a box drawn around the very thing the page is about.
 *
 * Flex-wrap, not a fixed grid: the old 4-column grid sized "2,191" and
 * "852,404 in / 1,382,390 out" identically and left a ragged hole wherever a
 * row ran out of facts. Each fact takes the width it needs and the row breaks
 * where it must.
 *
 * Values keep the `body` type role, so a page cannot quietly mute a fact the
 * reader came for (see `type-scale.ts`, rule 1). Numeric values should be
 * wrapped in `font-mono tabular-nums` by the caller so columns of digits line
 * up between visits to the page.
 */
export function DetailFacts({
  facts,
  className,
}: {
  facts: DetailFact[];
  className?: string;
}) {
  if (facts.length === 0) return null;

  return (
    <dl className={cn("flex flex-wrap gap-x-10 gap-y-4", className)}>
      {facts.map((fact) => (
        <div key={fact.label} className="min-w-0 space-y-1">
          <dt className={typeRole({ role: "label" })}>{fact.label}</dt>
          <dd className={cn(typeRole({ role: "body" }), "break-words")}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
