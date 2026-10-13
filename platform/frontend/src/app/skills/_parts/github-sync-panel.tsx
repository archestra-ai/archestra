"use client";

import {
  type archestraApiTypes,
  GIT_PROVIDER_LABELS,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { gitRepositoryUrlWithRef } from "@/components/git/git-source";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
} from "@/components/git/git-source-card";
import {
  GIT_SYNC_INTERVAL_LABELS,
  GitSourceEditDialog,
} from "@/components/git/git-source-edit-dialog";
import { Button } from "@/components/ui/button";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useUpdateSkillGithubSync } from "@/lib/skills/skill.query";
import { skillSourcePath } from "@/lib/skills/skill-source";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export type SkillDetail = archestraApiTypes.GetSkillResponses["200"];

/** A Git skill imported once and never pulled again. */
export function GithubSnapshotNotice({
  repo,
  provider = "github",
}: {
  repo: string | null;
  provider?: SkillDetail["sourceProvider"];
}) {
  const appName = useAppName();
  return (
    <div className="flex gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
      <GitProviderLogo
        provider={provider ?? "github"}
        className="mt-0.5 shrink-0"
      />
      <p>
        Imported from{" "}
        {repo ? (
          <code className="font-mono text-foreground">{repo}</code>
        ) : (
          <span>{GIT_PROVIDER_LABELS[provider ?? "github"]}</span>
        )}{" "}
        as a one-time copy. Saving changes here won’t update the repo, and{" "}
        {appName} won’t pull later changes from it.
      </p>
    </div>
  );
}

/**
 * A Git-synced skill's source at a glance, with an immediate pull, the sync
 * settings in a dialog, and disconnecting from the source (which makes the
 * skill editable and stops updates).
 */
export function GithubSyncPanel({
  skill,
  sourceRepo,
}: {
  skill: SkillDetail;
  sourceRepo: string | null;
}) {
  const updateGithubSync = useUpdateSkillGithubSync();
  const appName = useAppName();
  const [editing, setEditing] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const provider = skill.sourceProvider ?? "github";
  const providerLabel = GIT_PROVIDER_LABELS[provider];
  const repoPath = sourceRepo?.replace(/^https?:\/\/[^/]+\//, "") ?? null;
  const folder = skillSourcePath(skill.sourceRef);
  const href = repoPath
    ? gitWebUrls({
        host: gitHostFromUrl({ provider, url: skill.sourceOrigin }),
        path: repoPath,
      }).tree(skill.githubSyncRef ?? "HEAD", folder)
    : undefined;
  const lastSynced = skill.lastSyncedAt
    ? `Synced ${formatRelativeTimeFromNow(skill.lastSyncedAt).toLowerCase()}`
    : "Not synced yet";
  const syncing =
    updateGithubSync.isPending && !!updateGithubSync.variables?.body.syncNow;

  return (
    <>
      <GitSourceCard
        provider={provider}
        repo={repoPath ?? providerLabel}
        href={href}
        details={
          <>
            <GitSourceBranch branch={skill.githubSyncRef} />
            {folder && <span className="font-mono">{folder}</span>}
            <span>{lastSynced}</span>
          </>
        }
        sync={{
          onClick: () =>
            updateGithubSync.mutate({ id: skill.id, body: { syncNow: true } }),
          pending: syncing,
          tooltip: `Syncs ${GIT_SYNC_INTERVAL_LABELS[skill.githubSyncInterval ?? "1d"].toLowerCase()}. ${lastSynced}.`,
        }}
        footer={`Content is read-only here. Stop syncing to edit it in ${appName}.`}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setEditing(true)}
            >
              Edit source
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setConfirmingDisconnect(true)}
            >
              Stop syncing
            </Button>
          </>
        }
      >
        {skill.lastSyncError && (
          <GitSourceError
            title="Could not sync skill"
            message={skill.lastSyncError}
          />
        )}
      </GitSourceCard>
      {editing && (
        <GitSourceEditDialog
          name={skill.name}
          current={{
            provider,
            origin: skill.sourceOrigin,
            repo: repoPath ?? "",
            ref: skill.githubSyncRef,
            subpath: folder,
            credentialId:
              skill.gitlabTokenId ??
              skill.githubAppConfigId ??
              skill.githubPatId,
            interval: skill.githubSyncInterval,
          }}
          withSubpath
          subpathPlaceholder="skills/my-skill"
          syncDescription="New commits replace the skill’s content when they’re pulled."
          saving={updateGithubSync.isPending}
          onSave={async ({ auth, repository, interval }) => {
            // Only a moved source is fetched again; a new schedule alone is not.
            const moved =
              repository.path !== repoPath ||
              (repository.ref ?? null) !== (skill.githubSyncRef ?? null) ||
              repository.subpath !== folder ||
              (auth.gitlabTokenId ?? auth.githubAppConfigId ?? null) !==
                (skill.gitlabTokenId ?? skill.githubAppConfigId ?? null);
            const saved = await updateGithubSync.mutateAsync({
              id: skill.id,
              body: {
                interval: interval ?? "1d",
                ...(moved && {
                  source: {
                    ...auth,
                    repoUrl: gitRepositoryUrlWithRef(repository),
                    skillPath: repository.subpath,
                  },
                }),
              },
            });
            return !!saved;
          }}
          onOpenChange={setEditing}
        />
      )}
      <DeleteConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title={`Stop syncing from ${providerLabel}`}
        description={`Stop syncing "${skill.name}" from ${repoPath ?? `its ${providerLabel} source`}? It keeps its current content, becomes editable in ${appName}, and no longer receives updates from the repository.`}
        isPending={updateGithubSync.isPending}
        onConfirm={async () => {
          const result = await updateGithubSync.mutateAsync({
            id: skill.id,
            body: { disconnect: true },
          });
          if (result) setConfirmingDisconnect(false);
        }}
        confirmLabel="Stop syncing"
        pendingLabel="Stopping..."
      />
    </>
  );
}

/** Existing skills only (edit/preview with an id) — a skill being created has
 * no id to start a chat with yet. */
