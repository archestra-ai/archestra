"use client";

import {
  DEFAULT_GIT_WEB_URLS,
  GIT_PROVIDER_LABELS,
  type GitProvider,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";
import { GitPullRequestArrow } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
  GitSourceNotice,
} from "@/components/git/git-source-card";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  type PluginDetail,
  useTriggerPluginGithubSync,
  useUpdatePlugin,
} from "@/lib/plugins/plugin.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { pluginGitAuthentication } from "./plugin-draft";

export interface GitSourceOptions {
  provider: GitProvider;
  /** `value` encodes the credential as `<kind>:<id>`. */
  credentials: { value: string; label: string }[];
}

/**
 * A Git-sourced plugin's source at a glance: where its files come from, when
 * it last looked, an update waiting for review, and its settings in a dialog.
 */
export function PluginGitSourceCard({
  plugin,
  source,
  canEdit,
  onReview,
}: {
  plugin: PluginDetail;
  source: GitSourceOptions;
  canEdit: boolean;
  /** Opens the review of a pending update. */
  onReview: () => void;
}) {
  const check = useTriggerPluginGithubSync(plugin.id);
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
    ? `Checked ${formatRelativeTimeFromNow(plugin.lastSyncedAt).toLowerCase()}`
    : "Not checked yet";
  return (
    <>
      <GitSourceCard
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
                label: "Check now",
                onClick: () => check.mutate(),
                pending: check.isPending,
                tooltip: `${plugin.githubSyncInterval ? `Checks ${SYNC_LABELS[plugin.githubSyncInterval].toLowerCase()}` : "Checks only when asked"}. ${lastChecked}.`,
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
        <PluginSourceDialog
          plugin={plugin}
          source={source}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

// === Internal helpers ===

const SYNC_LABELS = {
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "1d": "Once a day",
} as const;

const MANUAL = "off";
const PUBLIC_ACCESS = "public";

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

/** Where a plugin's files come from, and how often it looks for changes. */
function PluginSourceDialog({
  plugin,
  source,
  onOpenChange,
}: {
  plugin: PluginDetail;
  source: GitSourceOptions;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdatePlugin(plugin.id);
  const initial = {
    repoUrl: plugin.sourceRepo ?? "",
    ref: plugin.githubSyncRef ?? plugin.sourceRef ?? "",
    interval: plugin.githubSyncInterval ?? MANUAL,
    credential: credentialValue(plugin),
  };
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<typeof values>) =>
    setValues((prev) => ({ ...prev, ...patch }));
  const gitlab = source.provider === "gitlab";
  const host = new URL(DEFAULT_GIT_WEB_URLS[source.provider]).host;
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await update.mutateAsync({
      githubSource: {
        repoUrl: values.repoUrl.trim(),
        ref: values.ref.trim() || null,
        syncInterval:
          values.interval === MANUAL
            ? null
            : (values.interval as keyof typeof SYNC_LABELS),
        ...(values.credential !== initial.credential && {
          authentication: pluginGitAuthentication(values.credential),
        }),
      },
    });
    if (saved) onOpenChange(false);
  };
  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      isDirty={dirty}
      title="Edit source"
      description={`Where ${plugin.displayName} gets its files, and how often it checks for changes.`}
      size="medium"
      className="w-[calc(100%-2rem)] sm:max-w-lg"
      bodyClassName="space-y-5"
      onSubmit={submit}
      footer={
        <>
          <DialogCancelButton disabled={update.isPending} />
          <Button
            type="submit"
            disabled={update.isPending || !dirty || !values.repoUrl.trim()}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="plugin-git-repo">
          {gitlab ? "Project" : "Repository"}
        </Label>
        <Input
          id="plugin-git-repo"
          value={values.repoUrl}
          onChange={(event) => set({ repoUrl: event.target.value })}
          placeholder={gitlab ? `${host}/group/project` : `${host}/owner/repo`}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="plugin-git-ref">Branch</Label>
          <Input
            id="plugin-git-ref"
            value={values.ref}
            onChange={(event) => set({ ref: event.target.value })}
            placeholder="Default branch"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="plugin-git-interval">Check for updates</Label>
          <Select
            value={values.interval}
            onValueChange={(interval) => set({ interval })}
          >
            <SelectTrigger id="plugin-git-interval" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANUAL}>Only when asked</SelectItem>
              {Object.entries(SYNC_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="plugin-git-credential">Sign in with</Label>
        <Select
          value={values.credential || PUBLIC_ACCESS}
          onValueChange={(value) =>
            set({ credential: value === PUBLIC_ACCESS ? "" : value })
          }
        >
          <SelectTrigger id="plugin-git-credential" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {source.credentials.map((credential) => (
              <SelectItem key={credential.value} value={credential.value}>
                {credential.label}
              </SelectItem>
            ))}
            <SelectItem value={PUBLIC_ACCESS}>
              Nothing ({gitlab ? "public project" : "public repository"})
            </SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          A saved {gitlab ? "GitLab token" : "GitHub credential"} that can read{" "}
          the {gitlab ? "project" : "repository"}. Add one in Settings &gt;
          Credentials.
        </FieldDescription>
      </div>
      <p className="text-xs text-muted-foreground">
        New commits never replace approved files on their own: they wait for
        your review.
      </p>
    </StandardFormDialog>
  );
}
