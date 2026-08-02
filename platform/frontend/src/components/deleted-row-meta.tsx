"use client";

import { useFeature } from "@/lib/config/config.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * "Deleted N ago" cell for trash views, plus — when the deployment's
 * soft-delete retention sweep is enabled — the purge countdown. Deliberately
 * "Eligible for deletion", not "Purged": the sweep can lag behind the date
 * (daily tick, batch ceiling, skipped still-referenced rows), so the copy
 * must not promise a moment the job does not guarantee.
 */
export function DeletedRowMeta({ deletedAt }: { deletedAt: string | null }) {
  const retention = useFeature("softDeleteRetention");

  if (!deletedAt) return null;

  const countdown =
    retention?.enabled === true
      ? eligibleForDeletionLabel(deletedAt, retention.days)
      : null;

  return (
    <div className="min-w-0">
      <div className="text-sm">
        <span>Deleted {formatRelativeTimeFromNow(deletedAt)}</span>
      </div>
      {countdown && (
        <div className="text-xs text-muted-foreground">
          <span>{countdown}</span>
        </div>
      )}
    </div>
  );
}

function eligibleForDeletionLabel(
  deletedAt: string,
  retentionDays: number,
): string {
  const eligibleAt =
    new Date(deletedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000;
  const daysLeft = Math.ceil((eligibleAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (daysLeft <= 0) return "Eligible for deletion";
  return `Eligible for deletion in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
}
