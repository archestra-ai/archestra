"use client";

import { Badge } from "@/components/ui/badge";

/** Historical server-owned snapshot, never today's resource labels. */
export function RequestAttributionLabels({
  labels,
}: {
  labels?: Record<string, string> | null;
}) {
  if (labels == null)
    return <span className="text-xs text-muted-foreground">Not captured</span>;
  const entries = Object.entries(labels).sort(([a], [b]) => {
    const rank = (key: string) =>
      key === "cost_center" ? 0 : key === "application" ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  if (!entries.length)
    return <span className="text-xs text-muted-foreground">Unassigned</span>;
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <Badge key={key} variant="secondary" className="max-w-full font-normal">
          <span className="font-medium">{key}:</span>
          <span className="ml-1 break-all">{value}</span>
        </Badge>
      ))}
    </div>
  );
}
