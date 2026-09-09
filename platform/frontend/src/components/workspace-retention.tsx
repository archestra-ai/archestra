"use client";

import {
  formatRuntimeDuration,
  useRuntimeClock,
} from "@/lib/agent-runtime-time";

export function WorkspaceRetention({ expiresAt }: { expiresAt: string }) {
  const now = useRuntimeClock(true);
  const deadline = new Date(expiresAt);
  const remaining = deadline.getTime() - now;
  return (
    <time
      dateTime={deadline.toISOString()}
      title={`Retained until ${deadline.toLocaleString()}`}
      className="shrink-0 tabular-nums"
    >
      {remaining <= 0
        ? "Retention expired"
        : remaining < 60_000
          ? "Retained for less than 1m"
          : `Retained for ${formatRuntimeDuration(remaining)}`}
    </time>
  );
}
