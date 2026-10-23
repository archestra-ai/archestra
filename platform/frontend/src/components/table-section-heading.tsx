"use client";

import type { ReactNode } from "react";
import {
  BulkActionsScope,
  useBulkActionsScope,
} from "@/components/ui/bulk-actions-context";

/**
 * A table section's title. Ticking rows swaps it for the section's bulk bar,
 * passed as `bulkActions`, so the bar takes no space of its own above the list.
 */
export function TableSectionHeading({
  title,
  bulkActions,
}: {
  title: string;
  bulkActions: ReactNode;
}) {
  return (
    <BulkActionsScope>
      <HeadingRow title={title} />
      {bulkActions}
    </BulkActionsScope>
  );
}

function HeadingRow({ title }: { title: string }) {
  const scope = useBulkActionsScope();
  return (
    // Same grid cell for both, as in FilterBar: `ContextualActionsPortal`
    // fades the `filter-controls` sibling out while the bar is shown.
    <div className="grid min-h-8">
      <h2
        data-slot="filter-controls"
        className="col-start-1 row-start-1 self-center text-sm font-medium uppercase tracking-wide text-muted-foreground transition-opacity duration-150 ease-out"
      >
        {title}
      </h2>
      {scope ? (
        <div
          id={scope.targetId}
          data-slot="contextual-actions"
          className="pointer-events-none col-start-1 row-start-1 flex min-w-0 items-center self-center opacity-0 transition-opacity duration-150 ease-out"
        />
      ) : null}
    </div>
  );
}

/**
 * A table section with nothing left to list because everything in it is
 * pinned above. Keeps the section's heading, so the page still says where
 * other items would appear, with one slim line instead of an empty table.
 */
export function EmptyTableSection({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <section className="space-y-3">
      <TableSectionHeading title={title} bulkActions={null} />
      <p className="flex min-h-11 items-center rounded-lg border border-dashed bg-muted/30 px-4 text-sm text-muted-foreground">
        {message}
      </p>
    </section>
  );
}
