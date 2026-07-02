import { Loader2 } from "lucide-react";

/**
 * Placeholder shown in a scheduled-run chat while its run is still executing. A
 * run's transcript is only persisted once it completes, so the thread would
 * otherwise render blank; this makes the "run in progress" state explicit and
 * pairs with hiding the composer until the run finishes.
 */
export function ScheduledRunInProgress() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Scheduled run in progress…
        </p>
        <p className="text-sm text-muted-foreground">
          This chat updates automatically when the run finishes.
        </p>
      </div>
    </div>
  );
}
