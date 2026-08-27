"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { type DetailFact, DetailFacts } from "@/components/detail-facts";

/** One key configuration value of the record, as `label` over `value`. */
export type OverviewFact = DetailFact;

/**
 * The Overview of a detail page: the record's key configuration on one row,
 * always visible, with the way into the full configuration beside it.
 *
 * It used to be a collapsible holding a read-only mirror of every step of the
 * record's edit wizard. That cost a click before the page said anything at
 * all, and what the click revealed was a second copy of the form the header's
 * Edit already opens. The handful of values a reader scans a detail page for
 * fit on one row; everything else is one link away, at the same place Edit
 * goes.
 */
export function OverviewSummary({
  headingId,
  facts,
  configHref,
  configLabel = "Configuration",
}: {
  headingId: string;
  facts: OverviewFact[];
  /**
   * The record's full configuration — the header's Edit destination. Omitted
   * for a reader who may not open it, so the section never offers a link that
   * answers 403.
   */
  configHref?: string;
  configLabel?: string;
}) {
  if (facts.length === 0 && !configHref) return null;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2
          id={headingId}
          className="text-base font-semibold tracking-tight text-foreground"
        >
          Overview
        </h2>
        {configHref && (
          <Link
            href={configHref}
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <span>{configLabel}</span>
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      {/* One row, wrapping rather than scrolling: a narrow window gets two
          short rows instead of a value cut off at the edge. */}
      <DetailFacts facts={facts} className="rounded-lg border bg-card p-4" />
    </section>
  );
}
