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
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Created by</span>
      {createdBy ? (
        <CreatedByCell createdBy={createdBy} />
      ) : (
        <span>unknown</span>
      )}
      {createdAt && (
        <span>
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
