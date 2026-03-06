import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ConnectorDotState = "active" | "paused" | "syncing" | "error";

export function getConnectorDotState({
  enabled,
  lastSyncStatus,
}: {
  enabled: boolean;
  lastSyncStatus: string | null;
}): ConnectorDotState {
  if (lastSyncStatus === "running") return "syncing";
  if (lastSyncStatus === "failed") return "error";
  if (!enabled) return "paused";
  return "active";
}

const DOT_CONFIG: Record<
  ConnectorDotState,
  { dotClass: string; pulse: boolean; label: string }
> = {
  active: { dotClass: "bg-green-500", pulse: false, label: "Active" },
  paused: { dotClass: "bg-muted-foreground", pulse: false, label: "Paused" },
  syncing: { dotClass: "bg-blue-500", pulse: true, label: "Syncing" },
  error: { dotClass: "bg-red-500", pulse: false, label: "Last sync failed" },
};

export function ConnectorStatusDot({ state }: { state: ConnectorDotState }) {
  const config = DOT_CONFIG[state];

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
