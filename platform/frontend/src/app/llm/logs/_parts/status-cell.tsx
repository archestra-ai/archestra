"use client";

import { cn } from "@/lib/utils/tailwind";
import type { LogSession } from "./logs-table-format";
import { describeSessionStatus } from "./session-status";

/** Failed (with what failed) or OK, so a broken session stands out in the list. */
export function StatusCell({
  session,
}: {
  session: Pick<LogSession, "chatErrorCount">;
}) {
  const status = describeSessionStatus(session);

  return (
    <div className="min-w-0 leading-5">
      <span
        className={cn(
          "flex items-center gap-1.5 text-sm",
          status.failed
            ? "font-medium text-destructive"
            : "text-muted-foreground",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status.failed ? "bg-destructive" : "bg-emerald-500",
          )}
        />
        <span>{status.failed ? "Failed" : "OK"}</span>
      </span>
      {status.detail ? (
        <span className="block truncate text-xs leading-4 text-muted-foreground">
          {status.detail}
        </span>
      ) : null}
    </div>
  );
}
