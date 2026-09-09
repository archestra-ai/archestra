import { Github, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PluginListItem } from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export function PluginSourceInfo({
  plugin,
}: {
  plugin: Pick<
    PluginListItem,
    | "sourceKind"
    | "sourceRepo"
    | "sourceMarketplaceRepo"
    | "githubSyncInterval"
    | "lastSyncedAt"
    | "pendingSourceSha"
    | "fileCount"
    | "updatedAt"
  >;
}) {
  const isGithub = plugin.sourceKind === "github";
  const hasUpdate = isGithub && !!plugin.pendingSourceSha;
  const Icon = isGithub ? Github : Pencil;
  const repo = plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-4 shrink-0 p-0 text-muted-foreground",
            hasUpdate &&
              "text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400",
          )}
          aria-label={
            isGithub
              ? hasUpdate
                ? "GitHub source: update available"
                : "GitHub source details"
              : "Manual source details"
          }
          onClick={(event) => event.stopPropagation()}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-3">
        <div className="space-y-1">
          {isGithub ? (
            <>
              {repo && <p className="break-all font-medium">{repo}</p>}
              <p>
                {plugin.githubSyncInterval
                  ? `${SYNC_INTERVAL_LABELS[plugin.githubSyncInterval]} from GitHub; new commits become review candidates.`
                  : "Imported from GitHub; updates are checked manually."}
                {` Last checked: ${formatRelativeTimeFromNow(
                  plugin.lastSyncedAt,
                  {
                    neverLabel: "not yet",
                  },
                )}.`}
              </p>
              {hasUpdate && (
                <p className="text-amber-600 dark:text-amber-400">
                  Update available. A new source commit is waiting for review on
                  the plugin page.
                </p>
              )}
            </>
          ) : (
            <p>Manually authored plugin.</p>
          )}
        </div>
        <div>
          <p>
            {plugin.fileCount} {plugin.fileCount === 1 ? "file" : "files"}
          </p>
          <p>
            Last updated:{" "}
            {formatDate({ date: plugin.updatedAt, dateFormat: "PPpp" })}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "Synced every 15 minutes",
  "1h": "Synced every hour",
  "1d": "Synced once a day",
};
