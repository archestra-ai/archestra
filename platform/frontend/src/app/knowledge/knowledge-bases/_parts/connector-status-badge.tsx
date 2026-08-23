"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate } from "@/lib/utils";

type ConnectorSyncStatus = NonNullable<
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number]["lastSyncStatus"]
>;

interface StatusConfig {
  label: string;
  className: string;
  animated: boolean;
}

const STATUS_CONFIG: Record<ConnectorSyncStatus, StatusConfig> = {
  queued: {
    label: "Queued",
    className: "bg-blue-500/10 text-blue-600 border border-blue-500/30",
    animated: false,
  },
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
  // Ran cleanly and indexed nothing, with nothing indexed before either —
  // nearly always a connector pointed somewhere it cannot see. Amber, not
  // green: a tick here is how one goes unnoticed for weeks.
  no_documents: {
    label: "No documents",
    className: "bg-amber-500/10 text-amber-600 border border-amber-500/30",
    animated: false,
  },
  partial: {
    label: "Partial",
    className: "bg-amber-500/10 text-amber-600 border border-amber-500/30",
    animated: false,
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-muted text-muted-foreground border border-border",
    animated: false,
  },
  superseded: {
    label: "Superseded",
    className: "bg-muted text-muted-foreground border border-border",
    animated: false,
  },
};

/**
 * Status badge plus the last-sync relative timestamp, as used in the
 * connectors and knowledge-bases table Status columns. The badge and the
 * timestamp each stay on one line, but wrap as whole units relative to each
 * other: side by side when the column is wide enough, timestamp under the
 * badge when it is not. The tables render with a fixed layout that does not
 * clip overflow, so anything wider than the column would paint over the
 * neighboring column instead of wrapping.
 */
export function ConnectorStatusCell({
  lastSyncAt,
  lastSyncStatus,
}: {
  lastSyncAt: string | null;
  lastSyncStatus: ConnectorSyncStatus | null;
}) {
  if (!lastSyncAt) {
    return <span className="text-xs text-muted-foreground">Never synced</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <ConnectorStatusBadge status={lastSyncStatus} />
      <span
        className="whitespace-nowrap text-xs text-muted-foreground"
        title={formatDate({ date: lastSyncAt })}
      >
        {formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}
      </span>
    </div>
  );
}

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
      <span>{config.label}</span>
    </Badge>
  );
}
