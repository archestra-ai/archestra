"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Github,
  GitPullRequestArrow,
  LoaderCircle,
} from "lucide-react";
import { useEffect } from "react";
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
 * query polls the row and sync checks the pull request every minute; coming
 * back to this tab (from merging on GitHub) checks at once.
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
  const web = query.data?.githubWebUrl ?? "https://github.com";
  const pullUrl = `${web}/${pullRequest.repo}/pull/${pullRequest.number}`;
  const merged = outcome === "merged";
  const pending = outcome === "pending";
  const { mutate, isPending } = update;
  useEffect(() => {
    if (!pending) return;
    const check = () => {
      if (document.visibilityState === "visible" && !isPending)
        mutate({ action: "sync" });
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [pending, isPending, mutate]);
  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title={merged ? "Setup finished" : "Finish GitHub sync"}
      description={
        merged
          ? "Your policy now comes from GitHub."
          : "Repository rules need a pull request. Your current policy stays active until it merges."
      }
      size="medium"
      bodyClassName="space-y-4"
      footer={
        <Button
          type="button"
          variant={merged ? "default" : "outline"}
          onClick={() => onOpenChange(false)}
        >
          {merged ? "Done" : "Close"}
        </Button>
      }
    >
      {pending && (
        <InlineNotice variant="info">
          <GitPullRequestArrow aria-hidden />
          <span className="font-medium">Merge the setup PR</span>
          <InlineNoticeText>Setup finishes once it merges.</InlineNoticeText>
          <Button
            asChild
            size="xs"
            variant="outline"
            className="ml-auto"
            data-slot="inline-notice-action"
          >
            <a href={pullUrl} target="_blank" rel="noreferrer">
              <span>Review and merge</span>
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </Button>
        </InlineNotice>
      )}
      <div className="divide-y rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Github className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <a
              className="block truncate text-sm font-medium hover:underline underline-offset-4"
              href={`${web}/${pullRequest.repo}`}
              target="_blank"
              rel="noreferrer"
            >
              {pullRequest.repo}
            </a>
            <p className="text-xs text-muted-foreground">
              Created from the OpenAPPA template
            </p>
          </div>
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
            <p
              className="flex items-center gap-1 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {merged ? (
                <span>Merged and synced</span>
              ) : pending && !source?.lastSyncError ? (
                <>
                  <LoaderCircle
                    className={cn("size-3", checking && "animate-spin")}
                    aria-hidden
                  />
                  <span>
                    {checking
                      ? "Checking…"
                      : source?.lastSyncedAt
                        ? `Waiting for merge · checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
                        : "Waiting for merge"}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          {merged ? (
            <Badge variant="outline">
              <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
              <span>Merged</span>
            </Badge>
          ) : null}
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
          <AlertTriangle aria-hidden />
          <span className="font-medium">Could not finish setup</span>
          <InlineNoticeText>{source.lastSyncError}</InlineNoticeText>
        </InlineNotice>
      ) : null}
    </StandardDialog>
  );
}
