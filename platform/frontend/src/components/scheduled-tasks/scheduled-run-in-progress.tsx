import { Loader2 } from "lucide-react";

/**
 * Placeholder before replay starts, or until a read-only run finishes.
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
          Output will appear here automatically.
        </p>
      </div>
    </div>
  );
}
