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
 * This component keeps one dialog mounted while the app loads. Once resolved,
 * {@link AppSettingsForm} fills that same modal with the left-nav settings
 * layout, avoiding a second modal entrance and focus cycle.
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={app ? "h-[85vh] max-w-5xl flex-row gap-0 p-0" : "max-w-lg"}
        showCloseButton={!app}
      >
        {app ? (
          <AppSettingsForm
            app={app}
            open={open}
            onOpenChange={onOpenChange}
            contentOnly
          />
        ) : (
          <>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
