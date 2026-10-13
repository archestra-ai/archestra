"use client";

import {
  type archestraApiTypes,
  GIT_PROVIDER_LABELS,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";
import { type FormEvent, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
} from "@/components/git/git-source-card";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useGitCredentials } from "@/lib/git-credentials.query";
import { useGithubPats } from "@/lib/github-pat.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useUpdateSkillGithubSync } from "@/lib/skills/skill.query";
import { skillSourcePath } from "@/lib/skills/skill-source";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export type SkillDetail = archestraApiTypes.GetSkillResponses["200"];

// lowercase: these render mid-sentence ("Checks every hour.")
const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "every 15 minutes",
  "1h": "every hour",
  "1d": "once a day",
};

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
          tooltip: `Checks ${SYNC_INTERVAL_LABELS[skill.githubSyncInterval ?? "1d"]}. ${lastSynced}.`,
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
              Edit sync
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
        <SkillSyncDialog
          skill={skill}
          repo={repoPath ?? providerLabel}
          href={href}
          folder={folder}
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

// === Internal helpers ===

/** Where the skill syncs from, and how often. Only the schedule can change. */
function SkillSyncDialog({
  skill,
  repo,
  href,
  folder,
  onOpenChange,
}: {
  skill: SkillDetail;
  repo: string;
  href?: string;
  folder: string;
  onOpenChange: (open: boolean) => void;
}) {
  const updateGithubSync = useUpdateSkillGithubSync();
  const current = skill.githubSyncInterval ?? "1d";
  const [interval, setInterval] = useState(current);
  const provider = skill.sourceProvider ?? "github";
  const { data: githubPats = [] } = useGithubPats();
  const { data: gitCredentials = [] } = useGitCredentials();
  const credentialId = skill.gitlabTokenId ?? skill.githubAppConfigId;
  const credentialName = skill.githubPatId
    ? githubPats.find((pat) => pat.id === skill.githubPatId)?.name
    : credentialId
      ? gitCredentials.find((entry) => entry.id === credentialId)?.name
      : undefined;
  const signIn = skill.githubPatId
    ? `Saved token${credentialName ? ` “${credentialName}”` : ""}`
    : skill.gitlabTokenId
      ? `GitLab token${credentialName ? ` “${credentialName}”` : ""}`
      : skill.githubAppConfigId
        ? `GitHub App${credentialName ? ` “${credentialName}”` : ""}`
        : `None (public ${provider === "gitlab" ? "project" : "repository"})`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    updateGithubSync.mutate(
      { id: skill.id, body: { interval: interval as "15m" | "1h" | "1d" } },
      { onSuccess: () => onOpenChange(false) },
    );
  };
  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      isDirty={interval !== current}
      title="Sync settings"
      description={`Where ${skill.name} comes from, and how often it checks for changes.`}
      size="medium"
      className="w-[calc(100%-2rem)] sm:max-w-lg"
      bodyClassName="space-y-5"
      onSubmit={submit}
      footer={
        <>
          <DialogCancelButton disabled={updateGithubSync.isPending} />
          <Button
            type="submit"
            disabled={updateGithubSync.isPending || interval === current}
          >
            {updateGithubSync.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md border bg-muted/30 px-4 py-3 text-sm">
        <dt className="text-muted-foreground">
          {provider === "gitlab" ? "Project" : "Repository"}
        </dt>
        <dd className="min-w-0 truncate">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              {repo}
            </a>
          ) : (
            repo
          )}
        </dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd>{skill.githubSyncRef || "Default branch"}</dd>
        {folder && (
          <>
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="min-w-0 truncate font-mono text-xs leading-5">
              {folder}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Sign-in</dt>
        <dd className="min-w-0 truncate">{signIn}</dd>
      </dl>
      <div className="space-y-2">
        <Label htmlFor="skill-sync-interval">Check for changes</Label>
        <Select
          value={interval}
          onValueChange={(value) => setInterval(value as typeof current)}
        >
          <SelectTrigger id="skill-sync-interval" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SYNC_INTERVAL_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label.charAt(0).toUpperCase() + label.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          New commits replace the skill’s content when they’re pulled.
        </FieldDescription>
      </div>
    </StandardFormDialog>
  );
}
