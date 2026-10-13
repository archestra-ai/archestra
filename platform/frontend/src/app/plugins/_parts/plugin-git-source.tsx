"use client";

import {
  GIT_PROVIDER_LABELS,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";
import { GitPullRequestArrow } from "lucide-react";
import { useState } from "react";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
  GitSourceNotice,
} from "@/components/git/git-source-card";
import {
  GIT_SYNC_INTERVAL_LABELS,
  GitSourceEditDialog,
} from "@/components/git/git-source-edit-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  type PluginDetail,
  useTriggerPluginGithubSync,
  useUpdatePlugin,
} from "@/lib/plugins/plugin.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { pluginGitAuthentication } from "./plugin-draft";

/**
 * A Git-sourced plugin's source at a glance: where its files come from, when
 * it last looked, an update waiting for review, and its settings in a dialog.
 */
export function PluginGitSourceCard({
  plugin,
  canEdit,
  onReview,
}: {
  plugin: PluginDetail;
  canEdit: boolean;
  /** Opens the review of a pending update. */
  onReview: () => void;
}) {
  const check = useTriggerPluginGithubSync(plugin.id);
  const update = useUpdatePlugin(plugin.id);
  const [editing, setEditing] = useState(false);
  const provider = plugin.sourceProvider ?? "github";
  const repo = repoPath(plugin.sourceRepo) ?? GIT_PROVIDER_LABELS[provider];
  const ref = plugin.githubSyncRef ?? plugin.sourceRef;
  const href = plugin.sourceRepo
    ? gitWebUrls({
        host: gitHostFromUrl({ provider, url: plugin.sourceOrigin }),
        path: repo,
      }).tree(ref ?? "HEAD", plugin.sourceSubdir ?? "")
    : undefined;
  const lastChecked = plugin.lastSyncedAt
    ? `Synced ${formatRelativeTimeFromNow(plugin.lastSyncedAt).toLowerCase()}`
    : "Not synced yet";
  return (
    <>
      <GitSourceCard
        sticky
        provider={provider}
        repo={repo}
        href={href}
        details={
          <>
            <GitSourceBranch branch={ref} />
            {plugin.sourceSubdir && (
              <span className="font-mono">{plugin.sourceSubdir}</span>
            )}
            <span>{lastChecked}</span>
          </>
        }
        sync={
          canEdit
            ? {
                onClick: () => check.mutate(),
                pending: check.isPending,
                tooltip: `${plugin.githubSyncInterval ? `Syncs ${GIT_SYNC_INTERVAL_LABELS[plugin.githubSyncInterval].toLowerCase()}` : "Syncs only when asked"}. ${lastChecked}.`,
              }
            : undefined
        }
        footer="Files are read-only here. New commits wait for your review."
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setEditing(true)}
            >
              Edit source
            </Button>
          ) : undefined
        }
      >
        {plugin.pendingSourceSha && (
          <GitSourceNotice>
            <InlineNotice variant="info">
              <GitPullRequestArrow aria-hidden />
              <span className="font-medium">Update ready for review</span>
              <InlineNoticeText className="flex-1">
                Nothing changes until you approve it.
              </InlineNoticeText>
              {canEdit && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ml-auto shrink-0"
                  onClick={onReview}
                >
                  Review
                </Button>
              )}
            </InlineNotice>
          </GitSourceNotice>
        )}
        {plugin.lastSyncError && (
          <GitSourceError
            title="Could not check for updates"
            message={plugin.lastSyncError}
          />
        )}
      </GitSourceCard>
      {editing && (
        <GitSourceEditDialog
          name={plugin.displayName}
          current={{
            provider,
            origin: plugin.sourceOrigin,
            repo,
            ref: plugin.githubSyncRef ?? plugin.sourceRef,
            subpath: "",
            credentialId:
              plugin.gitlabTokenId ??
              plugin.githubAppConfigId ??
              plugin.githubPatId,
            interval: plugin.githubSyncInterval,
          }}
          allowManual
          syncDescription="New commits wait for your review."
          saving={update.isPending}
          onSave={async ({ auth, repository, interval }) => {
            const credential = credentialValue(plugin);
            const next = auth.gitlabTokenId
              ? `gitlab_token:${auth.gitlabTokenId}`
              : auth.githubAppConfigId
                ? `github_app:${auth.githubAppConfigId}`
                : "";
            const saved = await update.mutateAsync({
              githubSource: {
                repoUrl: repository.repoUrl,
                ref: repository.ref,
                syncInterval: interval,
                ...(next !== credential && {
                  authentication: pluginGitAuthentication(next),
                }),
              },
            });
            return !!saved;
          }}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

// === Internal helpers ===

function repoPath(sourceRepo: string | null) {
  return sourceRepo?.replace(/^https?:\/\/[^/]+\//, "") ?? null;
}

function credentialValue(plugin: PluginDetail) {
  return plugin.githubAppConfigId
    ? `github_app:${plugin.githubAppConfigId}`
    : plugin.gitlabTokenId
      ? `gitlab_token:${plugin.gitlabTokenId}`
      : plugin.githubPatId
        ? `pat:${plugin.githubPatId}`
        : "";
}
