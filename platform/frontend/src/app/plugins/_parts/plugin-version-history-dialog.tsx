"use client";

import { GIT_PROVIDER_LABELS, type Permissions } from "@archestra/shared";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
  type PluginVersionDetail,
  usePlugin,
  usePluginVersion,
  usePluginVersions,
  useRestorePluginVersion,
} from "@/lib/plugins/plugin.query";
import { compareSkillVersionFiles } from "@/lib/skills/skill-version-diff";
import { languageForPath } from "@/lib/skills/skill-version-format";

/** Restoring a version is an edit to the plugin. */
const PLUGIN_UPDATE_PERMISSIONS: Permissions = { plugin: ["update"] };

/**
 * Browse a plugin's version history and restore an earlier version, in the
 * dialog skills use for theirs.
 *
 * A version holds the plugin's files and nothing else: its name, description
 * and other settings are not versioned, so neither the history nor a restore
 * says anything about them.
 *
 * Restoring saves the old files as a new version, so the history is only
 * ever added to.
 */
export function PluginVersionHistoryDialog(props: {
  pluginId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounted per plugin: the version being read belongs to the plugin it
  // was picked for.
  return <VersionHistory key={props.pluginId} {...props} />;
}

function VersionHistory({
  pluginId,
  open,
  onOpenChange,
}: {
  pluginId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const {
    data: plugin,
    isPending: isPluginLoading,
    refetch: refetchPlugin,
  } = usePlugin(open ? pluginId : null);
  const versionsQuery = usePluginVersions(open ? pluginId : null);
  const restoreVersion = useRestorePluginVersion();
  // The restore button checks this itself; the `r` key has to answer to it too.
  const { data: canUpdate } = useHasPermissions(
    PLUGIN_UPDATE_PERMISSIONS,
    pluginId ?? undefined,
  );

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<VersionViewMode>("changes");
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  const {
    versions,
    headVersion,
    activeVersion,
    isHead,
    hasPredecessor,
    predecessorVersion,
  } = useVersionTimeline({
    versionsQuery,
    // A plugin does not carry its head number; the newest listed version is it.
    headHint: null,
    selectedVersion,
  });

  const {
    data: detail,
    isPending: isDetailLoading,
    isError: isDetailUnavailable,
    refetch: refetchDetail,
  } = usePluginVersion(open ? pluginId : null, activeVersion);
  const predecessorQuery = usePluginVersion(
    open ? pluginId : null,
    predecessorVersion,
  );
  const predecessor = predecessorQuery.data ?? null;
  const baselineFailed = hasPredecessor && predecessorQuery.isError;
  // Comparing takes a baseline, so a version without one is read whole.
  const effectiveViewMode: VersionViewMode = predecessor ? viewMode : "all";
  const versionFiles = useMemo(
    () => (detail ? versionFilesOf(detail, predecessor) : []),
    [detail, predecessor],
  );

  // What a restore would do to the plugin as it stands today: its files are
  // replaced whole, so any it has now that the version lacks are removed.
  const filesDroppedByRestore = useMemo(() => {
    if (!plugin || !detail) return 0;
    const restoredPaths = new Set(detail.files.map((file) => file.path));
    return plugin.files.filter((file) => !restoredPaths.has(file.path)).length;
  }, [plugin, detail]);

  // A Git plugin's files are its repository's: they change by applying an
  // update, not by an edit here.
  const isGitPlugin = plugin?.sourceKind === "github";
  const host = GIT_PROVIDER_LABELS[plugin?.sourceProvider ?? "github"];
  const canRestore = !!detail && !!plugin && !isHead && !isGitPlugin;
  const activeHash =
    detail?.contentHash ??
    versions.find((version) => version.version === activeVersion)
      ?.contentHash ??
    null;

  const handleRestore = async () => {
    if (!plugin || activeVersion === null) return;
    // A refusal resolves to null and keeps the confirmation open, so the
    // toast explaining why still has the dialog it refers to on screen.
    const result = await restoreVersion
      .mutateAsync({
        pluginId: plugin.id,
        version: activeVersion,
        baseContentHash: plugin.contentHash,
      })
      .catch(() => null);
    if (!result) return;
    setConfirmingRestore(false);
    // The restore is the new head: read that.
    setSelectedVersion(null);
    void versionsQuery.refetch();
  };

  const shortcuts = useVersionHistoryShortcuts({
    enabled: !confirmingRestore,
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
          name={plugin?.displayName}
          versionCount={versions.length}
          hasMore={!!versionsQuery.hasNextPage}
          isLoading={versionsQuery.isPending}
          fallback="Every change to a plugin's files is kept as a version."
        />
      }
      notice={
        isGitPlugin ? (
          // Information, not a warning: it only says why Restore is
          // unavailable.
          <InlineNotice variant="neutral">
            <InlineNoticeText>
              This plugin&apos;s files come from {host}. Earlier versions stay
              viewable, but restoring one is unavailable: the files change by
              applying an update from the repository.
            </InlineNoticeText>
          </InlineNotice>
        ) : undefined
      }
      rail={
        <CommitGraphRail
          versions={versions}
          headVersion={headVersion}
          activeVersion={activeVersion}
          isLoading={versionsQuery.isPending || isPluginLoading}
          isError={versionsQuery.isError}
          errorMessage="Could not load this plugin's versions."
          onRetry={() => versionsQuery.refetch()}
          emptyMessage="No versions"
          hasMore={!!versionsQuery.hasNextPage}
          isLoadingMore={versionsQuery.isFetchingNextPage}
          onLoadMore={() => versionsQuery.fetchNextPage()}
          onSelect={setSelectedVersion}
        />
      }
      pane={
        // Every plugin has at least version 1, so there is no version to
        // show only while the reads are in flight or after one failed.
        activeVersion === null ? (
          isPluginLoading || versionsQuery.isPending ? (
            <PaneSkeleton />
          ) : (
            <div className="p-6">
              <LoadFailure
                message="Could not load this plugin."
                onRetry={() => {
                  refetchPlugin();
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
            baselineFailed={baselineFailed}
            onRetryBaseline={() => predecessorQuery.refetch()}
            isLoading={isDetailLoading}
            isUnavailable={isDetailUnavailable}
            onRetry={() => refetchDetail()}
            viewMode={effectiveViewMode}
            onViewModeChange={setViewMode}
            onSelectVersion={setSelectedVersion}
            // A plugin's source is a repository and a folder, not the
            // `owner/repo@ref:path` string the source link is built from.
            sourceRef={null}
            sourceOrigin={null}
            sourceProvider={null}
            restoreAction={
              <RestoreButton
                version={activeVersion}
                permissions={PLUGIN_UPDATE_PERMISSIONS}
                permissionScope={pluginId ?? undefined}
                canRestore={canRestore}
                isPending={restoreVersion.isPending}
                tooltip={
                  isGitPlugin
                    ? `This plugin's files come from ${host}. Apply an update from the repository to change them in ${appName}.`
                    : isHead
                      ? "This is the plugin's current version."
                      : undefined
                }
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
      {plugin && detail && activeVersion !== null ? (
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
          confirmVariant="default"
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
        />
      ) : null}
    </VersionHistoryShell>
  );
}

/**
 * A version's files, each paired with the predecessor's copy when there is
 * one. With no baseline the version is listed on its own, in path order, and
 * nothing claims to have moved.
 */
function versionFilesOf(
  detail: PluginVersionDetail,
  predecessor: PluginVersionDetail | null,
): VersionFile[] {
  const files = predecessor
    ? compareSkillVersionFiles(detail.files, predecessor.files)
    : [...detail.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          path: file.path,
          change: null,
          current: file,
          previous: null,
        }));
  return files.map((file) => ({
    path: file.path,
    change: file.change,
    current: file.current,
    previous: file.previous,
    language: languageForPath(file.path),
  }));
}

/** What a restore does to the plugin as it stands today. */
function restoreEffects({
  version,
  fileCount,
  droppedCount,
}: {
  version: number;
  fileCount: number;
  /** Files the plugin has today that this version does not. */
  droppedCount: number;
}): string {
  const files = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const restored = `Version ${version}'s ${files} become the plugin's files, as a new version. Installed copies change the next time they are updated.`;
  if (droppedCount === 0) return restored;
  const dropped = `${droppedCount} ${droppedCount === 1 ? "file" : "files"}`;
  return `${restored} The ${dropped} the plugin has now that version ${version} does not ${droppedCount === 1 ? "is" : "are"} removed.`;
}
