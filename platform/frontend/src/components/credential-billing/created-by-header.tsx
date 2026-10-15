"use client";

import { CreatedByCell } from "@/components/created-by-cell";
import { formatDate } from "@/lib/utils/date-time";

type CreatedBy = Parameters<typeof CreatedByCell>[0]["createdBy"];

/** "Created by [avatar] Name · Oct 7, 2026" for an edit dialog's header. */
export function CreatedByHeader({
  createdBy,
  createdAt,
}: {
  createdBy: CreatedBy | null | undefined;
  createdAt: Date | string | null | undefined;
}) {
  if (!createdBy && !createdAt) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span className="shrink-0">Created by</span>
      {createdBy ? (
        <CreatedByCell createdBy={createdBy} className="max-w-48" />
      ) : (
        <span>unknown</span>
      )}
      {createdAt && (
        <span className="shrink-0 whitespace-nowrap">
          ·{" "}
          {formatDate({
            date: new Date(createdAt).toISOString(),
            dateFormat: "MMM d, yyyy",
          })}
        </span>
      )}
    </span>
  );
}
