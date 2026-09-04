"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { format } from "date-fns";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppVersions, useRestoreAppVersion } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

type OwnedApp = Extract<
  archestraApiTypes.GetAppsResponses["200"]["data"][number],
  { source: "owned" }
>;
type AppVersion =
  archestraApiTypes.GetAppVersionSummariesResponses["200"][number];

/** Browse immutable app artifacts and copy an older one forward as a new head. */
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
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const [restoreTarget, setRestoreTarget] = useState<AppVersion | null>(null);
  const headVersion = versionsQuery.data?.[0]?.version ?? app.latestVersion;
  const canRestore =
    !!canUpdate && app.viewerRole !== "admin" && app.enabled && !app.locked;

  const handleRestore = async () => {
    if (!restoreTarget) return;
    const restored = await restoreVersion.mutateAsync({
      appId: app.id,
      version: restoreTarget.version,
      baseVersion: headVersion,
    });
    setRestoreTarget(null);
    if (restored) onOpenChange(false);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Version history"
      description={`Every content change to "${app.name}" is kept. Restoring a version adds a new version without rewriting history.`}
      size="medium"
      footer={
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      {versionsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading versions...</p>
      ) : versionsQuery.isError ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Could not load the version history.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => versionsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : versionsQuery.data?.length ? (
        <div className="max-h-96 divide-y overflow-y-auto rounded-md border">
          {versionsQuery.data.map((version) => {
            const current = version.version === headVersion;
            return (
              <div
                key={version.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      Version {version.version}
                    </span>
                    {current ? (
                      <Badge variant="secondary">Current</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(version.createdAt), "PPp")}
                  </p>
                </div>
                {!current ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canRestore}
                    title={restoreDisabledReason(app, !!canUpdate)}
                    onClick={() => setRestoreTarget(version)}
                  >
                    Restore
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No versions are available yet.
        </p>
      )}

      {restoreTarget ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setRestoreTarget(null);
          }}
          title={`Restore version ${restoreTarget.version}?`}
          description={`This copies version ${restoreTarget.version} forward as a new current version. Existing history is preserved.`}
          isPending={restoreVersion.isPending}
          onConfirm={() => void handleRestore()}
          confirmVariant="default"
          confirmLabel={`Restore version ${restoreTarget.version}`}
          pendingLabel="Restoring..."
        />
      ) : null}
    </StandardDialog>
  );
}

function restoreDisabledReason(
  app: OwnedApp,
  canUpdate: boolean,
): string | undefined {
  if (!canUpdate) return "You do not have permission to update apps.";
  if (app.locked) return "Unlock the app before restoring a version.";
  if (!app.enabled) return "Enable the app before restoring a version.";
  if (app.viewerRole === "admin") {
    return "Only an app author or collaborator can restore its content.";
  }
  return undefined;
}
