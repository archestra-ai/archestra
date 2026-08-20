"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AlertTriangle, Github, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useGithubPats } from "@/lib/github-pat.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useUpdateSkillGithubSync } from "@/lib/skills/skill.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export type SkillDetail = archestraApiTypes.GetSkillResponses["200"];

// lowercase: these render mid-sentence ("Synced from <repo> every hour …")
const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "every 15 minutes",
  "1h": "every hour",
  "1d": "once a day",
};

/**
 * Controls for a GitHub-synced skill: source + tracked ref, pull frequency,
 * last-sync status, an immediate pull, and disconnecting from the source
 * (which makes the skill editable and stops updates).
 */
/** A GitHub skill imported once and never pulled again. */
export function GithubSnapshotNotice({ repo }: { repo: string | null }) {
  const appName = useAppName();
  return (
    <div className="flex gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
      <Github className="mt-0.5 size-4 shrink-0" />
      <p>
        Imported from{" "}
        {repo ? (
          <code className="font-mono text-foreground">{repo}</code>
        ) : (
          <span>GitHub</span>
        )}{" "}
        as a one-time copy. Saving changes here won’t update the repo, and{" "}
        {appName} won’t pull later changes from it.
      </p>
    </div>
  );
}

export function GithubSyncPanel({
  skill,
  sourceRepo,
}: {
  skill: SkillDetail;
  sourceRepo: string | null;
}) {
  const updateGithubSync = useUpdateSkillGithubSync();
  const appName = useAppName();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // resolve the credential the scheduled pulls authenticate with; the lists
  // are permission-gated, so a viewer without githubAppConfig:read falls back
  // to the generic label.
  const { data: githubPats = [] } = useGithubPats();
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const patName = skill.githubPatId
    ? githubPats.find((pat) => pat.id === skill.githubPatId)?.name
    : undefined;
  const appConfigName = skill.githubAppConfigId
    ? githubAppConfigs.find((config) => config.id === skill.githubAppConfigId)
        ?.name
    : undefined;
  const authLabel = skill.githubPatId ? (
    <Link
      href="/settings/github"
      className="max-w-44 min-w-0 truncate underline underline-offset-4 hover:text-primary"
      title="Manage saved tokens in Settings → GitHub"
    >
      {patName ? `saved token “${patName}”` : "a saved token"}
    </Link>
  ) : skill.githubAppConfigId ? (
    appConfigName ? (
      `GitHub App “${appConfigName}”`
    ) : (
      "a GitHub App"
    )
  ) : (
    "no authentication (public repo)"
  );

  return (
    <div className="rounded-md border bg-muted/40 px-3 pt-2 pb-3">
      {/* the sentence: synced from <repo>, <cadence>, using <credential> */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-sm">
        <Github className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Synced from</span>
        {sourceRepo ? (
          <a
            href={`https://github.com/${sourceRepo}${skill.githubSyncRef ? `/tree/${skill.githubSyncRef}` : ""}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono underline underline-offset-4 hover:text-primary"
            title="Open on GitHub"
          >
            {sourceRepo}
            <span className="text-muted-foreground">
              {skill.githubSyncRef ? ` @ ${skill.githubSyncRef}` : ""}
            </span>
          </a>
        ) : (
          <span className="min-w-0 truncate font-mono">GitHub</span>
        )}
        <Select
          value={skill.githubSyncInterval ?? "1d"}
          onValueChange={(value) =>
            updateGithubSync.mutate({
              id: skill.id,
              body: { interval: value as "15m" | "1h" | "1d" },
            })
          }
          disabled={updateGithubSync.isPending}
        >
          <SelectTrigger
            size="sm"
            className="h-7 gap-1 px-2"
            aria-label="Sync frequency"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SYNC_INTERVAL_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">using</span>
        {authLabel}
        <div className="ml-auto shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              updateGithubSync.mutate({ id: skill.id, body: { syncNow: true } })
            }
            disabled={updateGithubSync.isPending}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync now
          </Button>
        </div>
      </div>
      {/* the consequence: read-only here until the sync is stopped */}
      <p className="mt-1.5 truncate pl-6 text-xs text-muted-foreground">
        {skill.lastSyncError ? (
          <span className="text-destructive">
            <AlertTriangle className="mr-1 inline size-3 align-[-2px]" />
            Last sync failed{" "}
            {formatRelativeTimeFromNow(skill.lastSyncedAt).toLowerCase()}:{" "}
            {skill.lastSyncError}
          </span>
        ) : (
          <>
            Last synced{" "}
            {formatRelativeTimeFromNow(skill.lastSyncedAt, {
              neverLabel: "never",
            }).toLowerCase()}
          </>
        )}
        {" · "}Content is read-only here —{" "}
        <button
          type="button"
          className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-primary"
          onClick={() => setConfirmingDisconnect(true)}
          disabled={updateGithubSync.isPending}
        >
          stop syncing
        </button>{" "}
        to edit it in {appName}.
      </p>
      <DeleteConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        title="Stop syncing from GitHub"
        description={`Stop syncing "${skill.name}" from ${sourceRepo ?? "its GitHub source"}? It keeps its current content, becomes editable in ${appName}, and no longer receives updates from the repository.`}
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
    </div>
  );
}

/** Existing skills only (edit/preview with an id) — a skill being created has
 * no id to start a chat with yet. */
