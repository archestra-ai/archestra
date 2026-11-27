"use client";

import { GIT_PROVIDER_LABELS, type Permissions } from "@archestra/shared";
import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import { CommitGraphRail } from "@/components/version-history/commit-graph-rail";
import { RestoreButton } from "@/components/version-history/commit-header";
import type { VersionViewMode } from "@/components/version-history/diff-summary-strip";
import { LoadFailure } from "@/components/version-history/load-failure";
import { PaneSkeleton } from "@/components/version-history/pane-states";
import { VersionHistoryStatusLine } from "@/components/version-history/status-line";
import { useVersionHistoryShortcuts } from "@/components/version-history/use-version-history-shortcuts";
import { useVersionTimeline } from "@/components/version-history/use-version-timeline";
import type { VersionFile } from "@/components/version-history/version-files";
import {
  VersionHistoryShell,
  VersionHistorySubtitle,
} from "@/components/version-history/version-history-shell";
import { VersionPreview } from "@/components/version-history/version-preview";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type SkillVersionDetail,
  useResetSkill,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import {
  compareSkillVersionFiles,
  type SkillFileChange,
} from "@/lib/skills/skill-version-diff";
import { languageForPath } from "@/lib/skills/skill-version-format";

/** SKILL.md is not a resource file, but the version lists it like one. */
const SKILL_MANIFEST_PATH = "SKILL.md";

/** The manifest is markdown; resource files take their language from the path. */
const SKILL_MANIFEST_LANGUAGE = "markdown";

/** Restoring and resetting are both edits to the skill. */
const SKILL_UPDATE_PERMISSIONS: Permissions = { skill: ["update"] };

/**
 * Browse a skill's immutable version history and restore an earlier one.
 *
 * A version captures the skill's instructions and resource files, and nothing
 * else: frontmatter fields live in their own columns and are not versioned, so
 * neither the history nor a restore says anything about them.
 *
 * Restoring forks forward — the old bytes become a new head version — so the
 * history is only ever appended to, and a sandbox that pinned a version keeps
 * replaying the bytes it was activated with.
 */
export function SkillVersionHistoryDialog(props: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting per skill drops the previewed version, which belongs to the
  // skill it was chosen for and means nothing for another one.
  return <VersionHistory key={props.skillId} {...props} />;
}

function VersionHistory({
  skillId,
  open,
  onOpenChange,
}: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const {
    data: skill,
    isPending: isSkillLoading,
    refetch: refetchSkill,
  } = useSkill(open ? skillId : null);
  const versionsQuery = useSkillVersions(open ? skillId : null);
  const restoreVersion = useRestoreSkillVersion();
  const resetSkill = useResetSkill();
  // The restore button checks this itself; the `r` key has to answer to it too.
  const { data: canUpdate } = useHasPermissions(
    SKILL_UPDATE_PERMISSIONS,
    skillId ?? undefined,
  );

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // Opens on what moved, the way `git show` does, and survives version
  // selection: whoever came to read diffs keeps reading diffs. A version with
  // no baseline still reads whole, whatever this says.
  const [viewMode, setViewMode] = useState<VersionViewMode>("changes");
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const {
    versions,
    headVersion,
    activeVersion,
    isHead,
    hasPredecessor,
    predecessorVersion,
  } = useVersionTimeline({
    versionsQuery,
    headHint: skill?.latestVersion,
    selectedVersion,
  });

  const {
    data: detail,
    isPending: isDetailLoading,
    isError: isDetailUnavailable,
    refetch: refetchDetail,
  } = useSkillVersion(open ? skillId : null, activeVersion);
  // Versions are contiguous from 1, so the diff baseline is simply the previous
  // number. There is one rule for the rest: a version is compared against its
  // predecessor when that predecessor loads, and shown on its own when it does
  // not — whether because there is none (version 1) or because the read failed.
  const predecessorQuery = useSkillVersion(
    open ? skillId : null,
    predecessorVersion,
  );
  const predecessor = predecessorQuery.data ?? null;
  const versionFiles = useMemo(
    () => (detail ? versionFilesOf(detail, predecessor) : []),
    [detail, predecessor],
  );
  // Worth saying out loud only when a baseline was expected and did not arrive;
  // version 1 having no predecessor is not a failure to report.
  const baselineFailed = hasPredecessor && predecessorQuery.isError;
  // Comparing takes a baseline, so a version without one stays on the whole
  // file list however the switcher was left on the version before it.
  const effectiveViewMode: VersionViewMode = predecessor ? viewMode : "all";

  // What a restore would do to the skill *as it stands today* — a different
  // question from what this version changed, and the one a confirmation has to
  // answer. `files` is a full replacement, so anything the skill has now and
  // this version lacks is dropped.
  const filesDroppedByRestore = useMemo(() => {
    if (!skill || !detail) return 0;
    const restoredPaths = new Set(detail.files.map((file) => file.path));
    return skill.files.filter((file) => !restoredPaths.has(file.path)).length;
  }, [skill, detail]);

  const isSynced = !!skill?.githubSyncInterval;
  const canRestore = !!detail && !!skill && !isHead && !isSynced;
  // Only a skill the app ships has a default to go back to.
  const isBuiltIn = skill?.sourceType === "built_in";
  const activeHash =
    detail?.contentHash ??
    versions.find((version) => version.version === activeVersion)
      ?.contentHash ??
    null;

  const handleRestore = async () => {
    if (!skill || !detail || activeVersion === null) return;
    // A handled failure resolves to null and a transport failure rejects; both
    // keep the confirmation open, so the toast explaining why still has the
    // dialog it refers to on screen. A restore that wrote nothing because the
    // version was already current still settles, and closes.
    const result = await restoreVersion
      .mutateAsync({
        skillId: skill.id,
        version: activeVersion,
        baseVersion: skill.latestVersion,
      })
      .catch(() => null);
    if (!result) return;
    setConfirmingRestore(false);
    // A restore lands as the new head, so the previewed version is no longer
    // what the skill looks like — jump the selection to the version just made.
    setSelectedVersion(result.latestVersion);
  };

  const shortcuts = useVersionHistoryShortcuts({
    enabled: !confirmingRestore && !confirmingReset,
    versions: versions.map((version) => version.version),
    activeVersion,
    headVersion,
    onSelectVersion: setSelectedVersion,
    hasMore: !!versionsQuery.hasNextPage,
    isLoadingMore: versionsQuery.isFetchingNextPage,
    onLoadMore: () => versionsQuery.fetchNextPage(),
    onToggleViewMode: predecessor
      ? () => setViewMode(effectiveViewMode === "changes" ? "all" : "changes")
      : undefined,
    hash: activeHash,
    onRestore:
      canRestore && canUpdate && !restoreVersion.isPending
        ? () => setConfirmingRestore(true)
        : undefined,
  });

  return (
    <VersionHistoryShell
      open={open}
      onOpenChange={onOpenChange}
      onKeyDown={shortcuts.onKeyDown}
      subtitle={
        <VersionHistorySubtitle
          name={skill?.name}
          versionCount={versions.length}
          hasMore={!!versionsQuery.hasNextPage}
          isLoading={versionsQuery.isPending}
          fallback="Every change to a skill's instructions or files is kept as a version."
        />
      }
      headerAction={
        // Resetting a built-in skill is the same move as restoring: go back to
        // a version someone already had. It sits here rather than in the row
        // menu so both are reachable from the history you read to decide.
        isBuiltIn ? (
          <PermissionButton
            permissions={SKILL_UPDATE_PERMISSIONS}
            permissionScope={skillId ?? undefined}
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={resetSkill.isPending}
            onClick={() => setConfirmingReset(true)}
          >
            <RotateCcw />
            <span>Reset to default</span>
          </PermissionButton>
        ) : undefined
      }
      notice={
        isSynced ? (
          // Information, not a warning: nothing is wrong, the notice only
          // says why Restore is unavailable.
          <InlineNotice variant="neutral">
            <InlineNoticeText>
              This skill&apos;s content is synced from GitHub. Earlier versions
              stay viewable, but restoring one is unavailable — stop syncing the
              skill in its editor to make it editable in {appName}.
            </InlineNoticeText>
          </InlineNotice>
        ) : undefined
      }
      rail={
        <CommitGraphRail
          versions={versions}
          headVersion={headVersion}
          activeVersion={activeVersion}
          isLoading={versionsQuery.isPending || isSkillLoading}
          // Every skill has at least version 1, so an empty list after a
          // failed fetch is an outage, not a history. Saying "No versions"
          // would state something that is never true of a live skill.
          isError={versionsQuery.isError}
          errorMessage="Could not load this skill's versions."
          onRetry={() => versionsQuery.refetch()}
          emptyMessage="No versions"
          hasMore={!!versionsQuery.hasNextPage}
          isLoadingMore={versionsQuery.isFetchingNextPage}
          onLoadMore={() => versionsQuery.fetchNextPage()}
          onSelect={setSelectedVersion}
        />
      }
      pane={
        // Every skill has at least version 1, so there is no version to show
        // only while the reads are in flight or after one of them failed.
        // Saying the skill has no history would state something that is never
        // true of a live skill.
        activeVersion === null ? (
          isSkillLoading || versionsQuery.isPending ? (
            <PaneSkeleton />
          ) : (
            // Worded apart from the timeline's own failure next to it: the head
            // is unknown because the *skill* did not load, which is a
            // different read from the version list the timeline reports on.
            <div className="p-6">
              <LoadFailure
                message="Could not load this skill."
                onRetry={() => {
                  refetchSkill();
                  versionsQuery.refetch();
                }}
              />
            </div>
          )
        ) : (
          <VersionPreview
            version={activeVersion}
            isHead={isHead}
            detail={detail ?? null}
            predecessor={predecessor}
            files={versionFiles}
            manifestPath={SKILL_MANIFEST_PATH}
            baselineFailed={baselineFailed}
            onRetryBaseline={() => predecessorQuery.refetch()}
            isLoading={isDetailLoading}
            isUnavailable={isDetailUnavailable}
            onRetry={() => refetchDetail()}
            viewMode={effectiveViewMode}
            onViewModeChange={setViewMode}
            onSelectVersion={setSelectedVersion}
            sourceRef={skill?.sourceRef ?? null}
            sourceOrigin={skill?.sourceOrigin ?? null}
            sourceProvider={skill?.sourceProvider ?? null}
            restoreAction={
              <RestoreButton
                version={activeVersion}
                permissions={SKILL_UPDATE_PERMISSIONS}
                permissionScope={skillId ?? undefined}
                canRestore={canRestore}
                isPending={restoreVersion.isPending}
                tooltip={restoreTooltip({
                  isSynced,
                  isHead,
                  appName,
                  host: GIT_PROVIDER_LABELS[skill?.sourceProvider ?? "github"],
                })}
                onClick={() => setConfirmingRestore(true)}
              />
            }
          />
        )
      }
      statusLine={
        <VersionHistoryStatusLine
          activeVersion={activeVersion}
          headVersion={headVersion}
          isHead={isHead}
          hash={activeHash}
          isBusy={isDetailLoading && !detail}
          notice={shortcuts.notice}
          reading={
            detail ? (effectiveViewMode === "changes" ? "diff" : "tree") : null
          }
          keys={{
            toggleView: !!predecessor,
            copyHash: !!activeHash,
            restore: canRestore && !!canUpdate,
          }}
        />
      }
    >
      {skill && detail && activeVersion !== null ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${activeVersion}?`}
          description={restoreEffects({
            version: activeVersion,
            fileCount: detail.files.length,
            droppedCount: filesDroppedByRestore,
          })}
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          // A restore only ever appends to the history, so it does not get the
          // red the delete and reset confirmations use.
          confirmVariant="default"
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
        />
      ) : null}

      {skill ? (
        <DeleteConfirmDialog
          open={confirmingReset}
          onOpenChange={setConfirmingReset}
          title="Reset skill"
          description={`Reset "${skill.name}" to the version ${appName} ships? Any local edits to its instructions and resource files are overwritten, and the shipped content is recorded as a new version.`}
          isPending={resetSkill.isPending}
          onConfirm={async () => {
            const result = await resetSkill.mutateAsync(skill.id);
            if (!result) return;
            setConfirmingReset(false);
            // The reset landed as a new head, so the previewed version is no
            // longer what the skill looks like. Falling back to the head is
            // enough here — unlike a restore, the response carries no version
            // number to select.
            setSelectedVersion(null);
          }}
          confirmLabel="Reset to default"
          pendingLabel="Resetting..."
        />
      ) : null}
    </VersionHistoryShell>
  );
}

/**
 * SKILL.md and the resource files of a version, each paired with the
 * predecessor's copy when there is one. With no baseline the version is listed
 * on its own — in the same path order the comparison produces — and nothing
 * claims to have moved.
 */
function versionFilesOf(
  detail: SkillVersionDetail,
  predecessor: SkillVersionDetail | null,
): VersionFile[] {
  const manifestChange: SkillFileChange | null = !predecessor
    ? null
    : predecessor.content !== detail.content
      ? "changed"
      : "unchanged";
  const manifest: VersionFile = {
    path: SKILL_MANIFEST_PATH,
    change: manifestChange,
    current: { content: detail.content, encoding: "utf8" },
    previous: predecessor
      ? { content: predecessor.content, encoding: "utf8" }
      : null,
    language: SKILL_MANIFEST_LANGUAGE,
  };
  const resources = predecessor
    ? compareSkillVersionFiles(detail.files, predecessor.files)
    : [...detail.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          path: file.path,
          change: null,
          current: file,
          previous: null,
        }));
  return [
    manifest,
    ...resources.map((file) => ({
      path: file.path,
      change: file.change,
      current: file.current,
      previous: file.previous,
      language: languageForPath(file.path),
    })),
  ];
}

/**
 * What a restore does to the skill as it stands today — the one thing a
 * confirmation has to answer. Everything a restore leaves alone, and the fact
 * that it appends rather than rewinds, is documented rather than repeated here
 * at the moment of clicking.
 *
 * The new version is deliberately not numbered: a restore whose content matches
 * the head is suppressed and creates nothing, and the head can move between
 * this preview and the write.
 */
function restoreEffects({
  version,
  fileCount,
  droppedCount,
}: {
  version: number;
  fileCount: number;
  /** Files the skill has today that this version does not, so a restore drops them. */
  droppedCount: number;
}): string {
  const files = `${fileCount} resource ${fileCount === 1 ? "file" : "files"}`;
  const restored = `Version ${version}'s instructions and its ${files} become the skill's content, as a new version.`;
  if (droppedCount === 0) return restored;
  const dropped = `${droppedCount} ${droppedCount === 1 ? "file" : "files"}`;
  return `${restored} The ${dropped} the skill has now that version ${version} does not ${droppedCount === 1 ? "is" : "are"} removed.`;
}

function restoreTooltip({
  isSynced,
  isHead,
  appName,
  host,
}: {
  isSynced: boolean;
  isHead: boolean;
  appName: string;
  host: string;
}): string | undefined {
  if (isSynced) {
    return `This skill is synced from ${host}. Stop syncing it to edit and restore it in ${appName}.`;
  }
  if (isHead) return "This is the skill's current version.";
  return undefined;
}
