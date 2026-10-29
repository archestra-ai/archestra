"use client";

import type { archestraApiTypes, Permissions } from "@archestra/shared";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { CommitGraphRail } from "@/components/version-history/commit-graph-rail";
import {
  CommitHeader,
  RestoreButton,
} from "@/components/version-history/commit-header";
import { PaneSkeleton } from "@/components/version-history/pane-states";
import { VersionHistoryStatusLine } from "@/components/version-history/status-line";
import { useVersionHistoryShortcuts } from "@/components/version-history/use-version-history-shortcuts";
import {
  VersionHistoryShell,
  VersionHistorySubtitle,
} from "@/components/version-history/version-history-shell";
import { useAppVersions, useRestoreAppVersion } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

type OwnedApp = Extract<
  archestraApiTypes.GetAppsResponses["200"]["data"][number],
  { source: "owned" }
>;

/**
 * Browse immutable app artifacts and copy an older one forward as a new head.
 * An app version has no content preview here, so the pane is the version's
 * header alone: the rail carries the history.
 */
export function AppVersionHistoryDialog({
  app,
  open,
  onOpenChange,
}: {
  app: OwnedApp;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const versionsQuery = useAppVersions(open ? app.id : null);
  const restoreVersion = useRestoreAppVersion();
  const { data: canUpdate } = useHasPermissions(APP_UPDATE_PERMISSIONS, app.id);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const versions = versionsQuery.data ?? [];
  const headVersion = versions[0]?.version ?? app.latestVersion;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion === headVersion;
  const active = versions.find((version) => version.version === activeVersion);
  const canRestoreApp =
    !!canUpdate && app.viewerRole !== "admin" && app.enabled && !app.locked;
  const canRestore = canRestoreApp && !isHead && !!active;

  const handleRestore = async () => {
    const restored = await restoreVersion.mutateAsync({
      appId: app.id,
      version: activeVersion,
      baseVersion: headVersion,
    });
    setConfirmingRestore(false);
    if (restored) onOpenChange(false);
  };

  const shortcuts = useVersionHistoryShortcuts({
    enabled: !confirmingRestore,
    versions: versions.map((version) => version.version),
    activeVersion,
    headVersion,
    onSelectVersion: setSelectedVersion,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: () => {},
    hash: null,
    onRestore: canRestore ? () => setConfirmingRestore(true) : undefined,
  });

  return (
    <VersionHistoryShell
      open={open}
      onOpenChange={onOpenChange}
      onKeyDown={shortcuts.onKeyDown}
      size="compact"
      subtitle={
        <VersionHistorySubtitle
          name={app.name}
          versionCount={versions.length}
          hasMore={false}
          isLoading={versionsQuery.isPending}
          fallback="Every content change to an app is kept."
        />
      }
      rail={
        <CommitGraphRail
          versions={versions}
          headVersion={headVersion}
          activeVersion={activeVersion}
          isLoading={versionsQuery.isPending}
          isError={versionsQuery.isError}
          errorMessage="Could not load the version history."
          onRetry={() => versionsQuery.refetch()}
          emptyMessage="No versions are available yet."
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          onSelect={setSelectedVersion}
        />
      }
      pane={
        active ? (
          <>
            <CommitHeader
              version={active.version}
              isHead={isHead}
              hash={null}
              parentHash={null}
              onSelectParent={setSelectedVersion}
              createdAt={active.createdAt}
              action={
                <RestoreButton
                  version={active.version}
                  permissions={APP_UPDATE_PERMISSIONS}
                  permissionScope={app.id}
                  canRestore={canRestore}
                  isPending={restoreVersion.isPending}
                  tooltip={
                    isHead
                      ? "This is the app's current version."
                      : restoreDisabledReason(app)
                  }
                  onClick={() => setConfirmingRestore(true)}
                />
              }
            />
            {isHead ? null : (
              <p className="px-6 py-5 text-sm text-muted-foreground">
                Restoring copies this version forward as a new current version.
                Existing history is preserved.
              </p>
            )}
          </>
        ) : versionsQuery.isPending ? (
          <PaneSkeleton />
        ) : null
      }
      statusLine={
        <VersionHistoryStatusLine
          activeVersion={active ? activeVersion : null}
          headVersion={headVersion}
          isHead={isHead}
          hash={null}
          isBusy={false}
          notice={shortcuts.notice}
          reading={null}
          keys={{ restore: canRestore }}
        />
      }
    >
      <DeleteConfirmDialog
        open={confirmingRestore}
        onOpenChange={setConfirmingRestore}
        title={`Restore version ${activeVersion}?`}
        description={`This copies version ${activeVersion} forward as a new current version. Existing history is preserved.`}
        isPending={restoreVersion.isPending}
        onConfirm={() => void handleRestore()}
        confirmVariant="default"
        confirmLabel={`Restore version ${activeVersion}`}
        pendingLabel="Restoring..."
      />
    </VersionHistoryShell>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const APP_UPDATE_PERMISSIONS: Permissions = { app: ["update"] };

/**
 * Why an app's content cannot be restored by this reader. A missing update
 * permission is the shared permission button's to explain.
 */
function restoreDisabledReason(app: OwnedApp): string | undefined {
  if (app.locked) return "Unlock the app before restoring a version.";
  if (!app.enabled) return "Enable the app before restoring a version.";
  if (app.viewerRole === "admin") {
    return "Only an app author or collaborator can restore its content.";
  }
  return undefined;
}
