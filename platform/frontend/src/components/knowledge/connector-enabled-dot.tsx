import type { archestraApiTypes } from "@archestra/shared";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ConnectorSyncStatus = NonNullable<
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number]["lastSyncStatus"]
>;

interface DotConfig {
  dotClass: string;
  pulse: boolean;
  label: string;
}

export function ConnectorStatusDot({
  enabled,
  lastSyncStatus,
}: {
  enabled: boolean;
  lastSyncStatus: ConnectorSyncStatus | null;
}) {
  const config = getDotConfig(enabled, lastSyncStatus);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {config.pulse && (
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.dotClass} opacity-75`}
              />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.dotClass}`}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="text-xs">{config.label}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The same state as {@link ConnectorStatusDot}, but named out loud.
 *
 * A bare dot works in a list, where the column it sits in says what it is
 * about and a tooltip is one hover away. A detail page header is not that: the
 * dot floated beside the connector's name meaning nothing in particular, which
 * is what an undecoded colour always means. Keyboard and screen reader users
 * never got the tooltip at all.
 */
export function ConnectorStatusPill({
  enabled,
  lastSyncStatus,
}: {
  enabled: boolean;
  lastSyncStatus: ConnectorSyncStatus | null;
}) {
  const config = getDotConfig(enabled, lastSyncStatus);

  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className="relative flex h-2 w-2 shrink-0">
        {config.pulse && (
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.dotClass} opacity-75`}
          />
        )}
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${config.dotClass}`}
        />
      </span>
      <span>{config.label}</span>
    </Badge>
  );
}

function getDotConfig(
  enabled: boolean,
  lastSyncStatus: ConnectorSyncStatus | null,
): DotConfig {
  if (lastSyncStatus === "running")
    return { dotClass: "bg-blue-500", pulse: true, label: "Syncing" };
  if (lastSyncStatus === "queued")
    return { dotClass: "bg-blue-500", pulse: false, label: "Sync queued" };
  if (lastSyncStatus === "failed")
    return { dotClass: "bg-red-500", pulse: false, label: "Last sync failed" };
  if (!enabled)
    return {
      dotClass: "bg-muted-foreground",
      pulse: false,
      label: "Paused",
    };
  return { dotClass: "bg-green-500", pulse: false, label: "Active" };
}
