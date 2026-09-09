import { RefreshCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PluginListItem } from "@/lib/plugins/plugin.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "Synced every 15 minutes",
  "1h": "Synced every hour",
  "1d": "Synced once a day",
};

export function PluginGithubSyncBadge({
  plugin,
}: {
  plugin: Pick<
    PluginListItem,
    "sourceKind" | "githubSyncInterval" | "lastSyncedAt"
  >;
}) {
  if (plugin.sourceKind !== "github") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          synced
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {plugin.githubSyncInterval
          ? `${SYNC_INTERVAL_LABELS[plugin.githubSyncInterval]} from GitHub; new commits become review candidates.`
          : "Imported from GitHub; updates are checked manually."}
        {` Last checked: ${formatRelativeTimeFromNow(plugin.lastSyncedAt, {
          neverLabel: "not yet",
        })}.`}
      </TooltipContent>
    </Tooltip>
  );
}
