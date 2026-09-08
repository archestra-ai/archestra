"use client";

import { LoadingState } from "@/components/loading";
import { AppSettingsForm } from "@/components/mcp-app/app-settings-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/lib/app.query";

/**
 * The one app-settings surface, opened from both the apps-page cards and the
 * chat side-panel header. Loads the full app by id and hosts {@link AppSettingsForm},
 * which renders the left-nav settings dialog (General/Tools/Access) plus the
 * Cancel/Save footer. Delete is intentionally not here (each host owns its own
 * separate delete action).
 *
 * {@link AppSettingsForm} owns the {@link TabbedDialogShell} — the same left-nav
 * dialog used by the identity-provider and team dialogs — so once the app is
 * loaded this component just mounts it. The transient load/error/unavailable
 * states render a small dialog with a Cancel button instead, since there is no
 * form to show yet.
 */
export function AppSettingsDialog({
  appId,
  open,
  onOpenChange,
}: {
  appId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Only fetch while open; the content unmounts on close, so reopening remounts
  // the form fresh from the (cached) app.
  const {
    data: app,
    isPending,
    isLoadingError,
    refetch,
  } = useApp(open ? appId : null, { toastOnError: false });

  const close = () => onOpenChange(false);

  // Once the app resolves, the form owns the whole (left-nav) dialog.
  if (open && app) {
    return (
      <AppSettingsForm app={app} open={open} onOpenChange={onOpenChange} />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>App settings</DialogTitle>
          <DialogDescription>
            Manage this app's details, tools, and who can use it.
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <LoadingState
            className="min-h-40 flex-1"
            label="Loading app settings…"
            variant="compact"
          />
        ) : isLoadingError ? (
          <QueryLoadError
            title="Couldn't load app settings"
            onRetry={() => refetch()}
            className="min-h-40 flex-1"
          />
        ) : (
          <output
            aria-label="App settings unavailable"
            className="flex min-h-40 flex-1 items-center justify-center text-sm text-muted-foreground"
          >
            App settings are unavailable.
          </output>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
