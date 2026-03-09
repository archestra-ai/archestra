"use client";

import type { archestraApiTypes } from "@shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ConnectorSyncStatus = NonNullable<
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number]["lastSyncStatus"]
>;

interface StatusConfig {
  label: string;
  className: string;
  animated: boolean;
}

const STATUS_CONFIG: Record<ConnectorSyncStatus, StatusConfig> = {
  success: {
    label: "Success",
    className: "bg-green-500/10 text-green-600 border border-green-500/30",
    animated: false,
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/10 text-red-600 border border-red-500/30",
    animated: false,
  },
  running: {
    label: "Running",
    className: "bg-blue-500/10 text-blue-600 border border-blue-500/30",
    animated: true,
  },
  completed_with_errors: {
    label: "Completed with errors",
    className: "bg-amber-500/10 text-amber-600 border border-amber-500/30",
    animated: false,
  },
  partial: {
    label: "Partial",
    className: "bg-amber-500/10 text-amber-600 border border-amber-500/30",
    animated: false,
  },
};

export function ConnectorStatusBadge({
  status,
}: {
  status: ConnectorSyncStatus | null;
}) {
  if (!status) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Never synced
      </Badge>
    );
  }

  const config = STATUS_CONFIG[status];

  return (
    <Badge variant="secondary" className={cn(config.className)}>
      {config.animated && (
        <span className="mr-1.5 h-2 w-2 rounded-full bg-current animate-pulse" />
      )}
      {config.label}
    </Badge>
  );
}
