"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ConnectorStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Never synced
      </Badge>
    );
  }

  const config = getStatusConfig(status);

  return (
    <Badge variant="secondary" className={cn(config.className)}>
      {config.animated && (
        <span className="mr-1.5 h-2 w-2 rounded-full bg-current animate-pulse" />
      )}
      {config.label}
    </Badge>
  );
}

function getStatusConfig(status: string) {
  switch (status) {
    case "success":
      return {
        label: "Success",
        className: "bg-green-500/10 text-green-600 border border-green-500/30",
        animated: false,
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-red-500/10 text-red-600 border border-red-500/30",
        animated: false,
      };
    case "running":
      return {
        label: "Running",
        className: "bg-blue-500/10 text-blue-600 border border-blue-500/30",
        animated: true,
      };
    default:
      return {
        label: status,
        className: "",
        animated: false,
      };
  }
}
