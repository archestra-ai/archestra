"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Github,
  GitPullRequestArrow,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { setupPullRequestOutcome } from "./setup-pull-request";

/**
 * Waits with the operator on the initial policy pull request. The status
 * query polls the row; sync checks the pull request every minute and imports
 * the policy once it merges, and "Check if merged" runs that check at once.
 */
export function OpenAppaSetupPullRequestDialog({
  pullRequest,
  onOpenChange,
}: {
  pullRequest: { repo: string; number: number };
  onOpenChange: (open: boolean) => void;
}) {
  const query = useAppaGithubSync();
  const update = useUpdateAppaGithubSync();
  const source = query.data?.source ?? null;
  const outcome = setupPullRequestOutcome(source, pullRequest.number);
  const checking = update.isPending && update.variables?.action === "sync";
  const pullUrl = `https://github.com/${pullRequest.repo}/pull/${pullRequest.number}`;
  const merged = outcome === "merged";
  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title={merged ? "Setup finished" : "Finish setup in GitHub"}
      description={
        merged
          ? "The initial policy pull request merged. Your policy now comes from GitHub, and every change is a reviewed pull request."
          : "Repository rules require a pull request. We opened one with your current policy. Merge it to finish setup. Your current policy stays active until it merges."
      }
      size="medium"
      bodyClassName="space-y-4"
      footer={
        <>
          <Button variant="ghost" asChild>
            <Link href="/settings/openappa">Sync settings</Link>
          </Button>
          <Button
            type="button"
            variant={merged ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            {merged ? "Done" : "Close"}
          </Button>
        </>
      }
    >
      <div className="divide-y rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Github className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <a
              className="block truncate text-sm font-medium hover:underline underline-offset-4"
              href={`https://github.com/${pullRequest.repo}`}
              target="_blank"
              rel="noreferrer"
            >
              {pullRequest.repo}
            </a>
            <p className="text-xs text-muted-foreground">
              Created from the OpenAPPA template
            </p>
          </div>
          {merged && (
            <Badge variant="outline">
              <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
              <span>Connected</span>
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <GitPullRequestArrow className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <a
              className="block truncate text-sm font-medium hover:underline underline-offset-4"
              href={pullUrl}
              target="_blank"
              rel="noreferrer"
            >
              Initial policy{" "}
              <span className="font-normal text-muted-foreground">
                #{pullRequest.number}
              </span>
            </a>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {merged && source?.sourceCommit
                ? `Merged. Policy synced from ${source.sourceCommit.slice(0, 7)}.`
                : source?.lastSyncedAt
                  ? `Last checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
                  : "Not checked yet"}
            </p>
          </div>
          <Badge variant={source?.lastSyncError ? "destructive" : "outline"}>
            {merged ? (
              <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
            ) : source?.lastSyncError ? (
              <AlertTriangle />
            ) : (
              <LoaderCircle className="animate-spin text-muted-foreground" />
            )}
            <span>
              {merged
                ? "Merged"
                : checking
                  ? "Checking…"
                  : source?.lastSyncError
                    ? "Needs attention"
                    : "Awaiting merge"}
            </span>
          </Badge>
        </div>
      </div>
      {outcome === "gone" ? (
        <InlineNotice variant="info">
          <InlineNoticeText>
            GitHub sync was stopped or re-pointed while this was open. Reconnect
            it from the GitHub sync card.
          </InlineNoticeText>
        </InlineNotice>
      ) : source?.lastSyncError ? (
        <InlineNotice variant="error">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="font-medium">Could not finish setup</span>
          <InlineNoticeText>{source.lastSyncError}</InlineNoticeText>
        </InlineNotice>
      ) : null}
      {outcome === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <a href={pullUrl} target="_blank" rel="noreferrer">
              <span>
                {source?.lastSyncError
                  ? "Open PR on GitHub"
                  : "Review and merge PR"}
              </span>
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ action: "sync" })}
          >
            <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
            <span>{checking ? "Checking…" : "Check if merged"}</span>
          </Button>
          <p className="basis-full text-xs text-muted-foreground">
            We keep checking for the merge. You can close this and come back
            from the GitHub sync card.
          </p>
        </div>
      )}
      {merged && (
        <p className="text-xs text-muted-foreground">
          Updates apply to new conversations. Active conversations keep their
          current policy.
        </p>
      )}
    </StandardDialog>
  );
}
