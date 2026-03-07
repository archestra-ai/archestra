import type { archestraApiTypes } from "@shared";
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

function getDotConfig(
  enabled: boolean,
  lastSyncStatus: ConnectorSyncStatus | null,
): DotConfig {
  if (lastSyncStatus === "running")
    return { dotClass: "bg-blue-500", pulse: true, label: "Syncing" };
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
