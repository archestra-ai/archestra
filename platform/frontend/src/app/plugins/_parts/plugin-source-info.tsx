import { GIT_PROVIDER_LABELS } from "@archestra/shared";
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

/**
 * Where an imported plugin comes from, and how it is kept up to date.
 *
 * Renders nothing for a plugin written in the app: it has no source to name,
 * and a "Manual" mark only made a reader wonder what was manual about it.
 */
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
  if (plugin.sourceKind !== "github") return null;
  const hasUpdate = !!plugin.pendingSourceSha;
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
            hasUpdate
              ? `${host} source: update available`
              : `${host} source details`
          }
          onClick={(event) => event.stopPropagation()}
        >
          <GitProviderLogo
            provider={plugin.sourceProvider ?? "github"}
            size={14}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-3">
        <div className="space-y-1">
          {repo && (
            <p className="break-all font-medium">{repositoryLabel(repo)}</p>
          )}
          <p>
            {plugin.githubSyncInterval
              ? `${SYNC_INTERVAL_LABELS[plugin.githubSyncInterval]} from ${host}; new commits become review candidates.`
              : `Imported from ${host}; updates are checked manually.`}
            {` Last checked: ${formatRelativeTimeFromNow(plugin.lastSyncedAt, {
              neverLabel: "not yet",
            })}.`}
          </p>
          {hasUpdate && (
            <p className="text-amber-600 dark:text-amber-400">
              Update available. A new source commit is waiting for review on the
              plugin page.
            </p>
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

/**
 * An imported plugin's source as one line: the host's mark, which opens the
 * details, and the repository it came from. Nothing for a plugin written in
 * the app. The table row and the card both show this line, so the two views
 * name the source the same way.
 */
export function PluginSourceLabel({
  plugin,
  className,
}: {
  plugin: Parameters<typeof PluginSourceInfo>[0]["plugin"];
  className?: string;
}) {
  if (plugin.sourceKind !== "github") return null;
  const repo = pluginRepository(plugin);
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <PluginSourceInfo plugin={plugin} />
      {repo && <span className="truncate">{repositoryLabel(repo)}</span>}
    </span>
  );
}

const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "Synced every 15 minutes",
  "1h": "Synced every hour",
  "1d": "Synced once a day",
};
