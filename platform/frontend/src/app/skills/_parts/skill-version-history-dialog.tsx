"use client";

import { GIT_PROVIDER_LABELS, type Permissions } from "@archestra/shared";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import { CommitGraphRail } from "@/components/version-history/commit-graph-rail";
import {
  CommitHeader,
  RestoreButton,
  UnreadVersionHeader,
} from "@/components/version-history/commit-header";
import {
  DiffSummaryStrip,
  type VersionViewMode,
} from "@/components/version-history/diff-summary-strip";
import { HunkScrollArea } from "@/components/version-history/hunk-block";
import { LoadFailure } from "@/components/version-history/load-failure";
import {
  NothingToDiff,
  PaneMessage,
  PaneSkeleton,
} from "@/components/version-history/pane-states";
import { ShortHash } from "@/components/version-history/refs";
import { VersionHistoryStatusLine } from "@/components/version-history/status-line";
import { useVersionHistoryShortcuts } from "@/components/version-history/use-version-history-shortcuts";
import {
  VersionHistoryShell,
  VersionHistorySubtitle,
} from "@/components/version-history/version-history-shell";
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
import { githubSourceUrlAtCommit } from "@/lib/skills/skill-source";
import {
  compareSkillVersionFiles,
  type SkillFileChange,
} from "@/lib/skills/skill-version-diff";
import { languageForPath } from "@/lib/skills/skill-version-format";
import {
  SKILL_MANIFEST_PATH,
  type SkillVersionFile,
  SkillVersionFiles,
  summarizeSkillChanges,
} from "./skill-version-files";

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

  // Pages are read by offset from a list that grows at the head, so a version
  // created between two page loads shifts every row down and the next page
  // re-returns rows the previous one already held. Keyed by id, the second copy
  // is dropped instead of rendering the version twice under a duplicate key.
  const versions = useMemo(() => {
    const seen = new Set<string>();
    return (versionsQuery.data?.pages ?? []).flatMap((page) =>
      (page?.data ?? []).filter((version) => {
        if (seen.has(version.id)) return false;
        seen.add(version.id);
        return true;
      }),
    );
  }, [versionsQuery.data]);
  const headVersion = skill?.latestVersion ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;

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
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  const predecessorQuery = useSkillVersion(
    open ? skillId : null,
    hasPredecessor ? (activeVersion as number) - 1 : null,
  );
  const predecessor = predecessorQuery.data ?? null;
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
          <InlineNotice>
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
 * One version, read either way: every file it holds, or only what moved as a
 * set of diffs under a `git diff --stat`. The switcher decides both what is
 * listed and how each file renders, so a changed file can be read whole under
 * "All files" and as a comparison under "Changes".
 */
function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  baselineFailed,
  onRetryBaseline,
  isLoading,
  isUnavailable,
  onRetry,
  viewMode,
  onViewModeChange,
  onSelectVersion,
  sourceRef,
  sourceOrigin,
  sourceProvider,
  restoreAction,
}: {
  version: number;
  isHead: boolean;
  detail: SkillVersionDetail | null;
  predecessor: SkillVersionDetail | null;
  /** A baseline was expected and the read failed, so there is nothing to compare against. */
  baselineFailed: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  /** This version itself could not be read — distinct from it not existing. */
  isUnavailable: boolean;
  onRetry: () => void;
  /** Already settled against the baseline: "all" whenever there is none. */
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
  onSelectVersion: (version: number) => void;
  /** The skill's provenance string, paired with a version's commit to link out. */
  sourceRef: string | null;
  sourceOrigin: string | null;
  sourceProvider: "github" | "gitlab" | null;
  restoreAction: ReactNode;
}) {
  const versionFiles = useMemo(
    () => (detail ? versionFilesOf(detail, predecessor) : []),
    [detail, predecessor],
  );

  if (isLoading && !detail) return <PaneSkeleton />;
  // A 404 is the only reading that supports "no longer available": the version
  // was pruned. A failed read supports nothing about the history at all, so it
  // says what happened and offers a way back rather than leaving the dialog
  // with no route out.
  if (!detail) {
    return (
      <>
        <UnreadVersionHeader version={version} action={restoreAction} />
        {isUnavailable ? (
          <div className="p-6">
            <LoadFailure
              message={`Version ${version} could not be loaded.`}
              onRetry={onRetry}
            />
          </div>
        ) : (
          <PaneMessage>This version is no longer available.</PaneMessage>
        )}
      </>
    );
  }

  // "All files" is the version itself, so a file it dropped has no hunk there.
  // "Changes" is what moved, which is exactly where a dropped file belongs —
  // and an untouched SKILL.md has no place in it.
  const heldFiles = versionFiles.filter((file) => file.current !== null);
  const movedFiles = versionFiles.filter(
    (file) => file.change !== null && file.change !== "unchanged",
  );
  const entries = viewMode === "all" ? heldFiles : movedFiles;
  const summary = summarizeSkillChanges(movedFiles);
  const provider = sourceProvider ?? "github";
  const sourceUrl = githubSourceUrlAtCommit({
    sourceRef,
    sourceOrigin,
    provider: sourceProvider,
    commit: detail.sourceCommit,
  });

  return (
    <>
      <CommitHeader
        version={version}
        isHead={isHead}
        hash={detail.contentHash}
        parentHash={predecessor?.contentHash ?? null}
        onSelectParent={onSelectVersion}
        createdAt={detail.createdAt}
        extraRows={
          // Only versions a Git pull produced. The link is named rather than
          // spelled out as a SHA, which stays in its title.
          sourceUrl && detail.sourceCommit ? (
            <>
              <dt className="leading-5 text-muted-foreground">source</dt>
              <dd className="flex min-w-0 items-center gap-2 leading-5">
                <GitProviderLogo provider={provider} size={12} />
                <ShortHash hash={detail.sourceCommit} />
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-sans text-muted-foreground underline underline-offset-4 hover:text-primary"
                  title={`Open this version's source on ${GIT_PROVIDER_LABELS[provider]} (${detail.sourceCommit})`}
                >
                  Open version in {GIT_PROVIDER_LABELS[provider]}
                </a>
              </dd>
            </>
          ) : null
        }
        action={restoreAction}
      />
      <DiffSummaryStrip
        version={version}
        unavailableReason={
          predecessor ? null : compareUnavailableReason(version, baselineFailed)
        }
        baselineFailed={baselineFailed}
        onRetryBaseline={onRetryBaseline}
        added={summary.added}
        removed={summary.removed}
        phrases={summary.phrases}
        changeCount={movedFiles.length}
        heldCount={heldFiles.length}
        allLabel="All files"
        mode={viewMode}
        onModeChange={onViewModeChange}
      />
      <HunkScrollArea isStale={false}>
        {entries.length === 0 ? (
          <NothingToDiff>
            Version {version} holds the same files as version {version - 1}.
          </NothingToDiff>
        ) : (
          <SkillVersionFiles
            // Remounting per version and reading resets every hunk's fold.
            key={`${version}-${viewMode}`}
            files={entries}
            mode={viewMode}
          />
        )}
      </HunkScrollArea>
    </>
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
): SkillVersionFile[] {
  const manifestChange: SkillFileChange | null = !predecessor
    ? null
    : predecessor.content !== detail.content
      ? "changed"
      : "unchanged";
  const manifest: SkillVersionFile = {
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

/** Why this version cannot be compared — each reading is a different fact. */
function compareUnavailableReason(
  version: number,
  baselineFailed: boolean,
): string {
  if (version <= 1) {
    return "This is the earliest version, so there is nothing to compare it against.";
  }
  if (baselineFailed) {
    return `Version ${version - 1} could not be loaded, so there is nothing to compare against.`;
  }
  return `Loading version ${version - 1}...`;
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
