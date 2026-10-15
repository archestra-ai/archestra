import { GIT_PROVIDER_LABELS } from "@archestra/shared";
import { Pencil } from "lucide-react";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PluginListItem } from "@/lib/plugins/plugin.query";
import { repositoryLabel } from "@/lib/skills/skill-source";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { pluginRepository } from "./plugin-source-icon";

export function PluginSourceInfo({
  plugin,
}: {
  plugin: Pick<
    PluginListItem,
    | "sourceKind"
    | "sourceRepo"
    | "sourceMarketplaceRepo"
    | "sourceProvider"
    | "sourceOrigin"
    | "githubSyncInterval"
    | "lastSyncedAt"
    | "pendingSourceSha"
    | "fileCount"
    | "updatedAt"
  >;
}) {
  const isGithub = plugin.sourceKind === "github";
  const hasUpdate = isGithub && !!plugin.pendingSourceSha;
  const host = GIT_PROVIDER_LABELS[plugin.sourceProvider ?? "github"];
  const repo = pluginRepository(plugin);

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
                ? `${host} source: update available`
                : `${host} source details`
              : "Manual source details"
          }
          onClick={(event) => event.stopPropagation()}
        >
          {isGithub ? (
            <GitProviderLogo
              provider={plugin.sourceProvider ?? "github"}
              size={14}
            />
          ) : (
            <Pencil className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-3">
        <div className="space-y-1">
          {isGithub ? (
            <>
              {repo && (
                <p className="break-all font-medium">{repositoryLabel(repo)}</p>
              )}
              <p>
                {plugin.githubSyncInterval
                  ? `${SYNC_INTERVAL_LABELS[plugin.githubSyncInterval]} from ${host}; new commits become review candidates.`
                  : `Imported from ${host}; updates are checked manually.`}
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
