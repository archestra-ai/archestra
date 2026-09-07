"use client";

import { FormDialog } from "@/components/form-dialog";
import { LoadingState } from "@/components/loading";
import { AppSettingsForm } from "@/components/mcp-app/app-settings-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { useApp } from "@/lib/app.query";

/**
 * The one app-settings surface, opened from both the apps-page cards and the
 * chat side-panel header. Loads the full app by id and hosts {@link AppSettingsForm},
 * which renders the settings fields plus the Cancel/Save footer. Delete is
 * intentionally not here (each host owns its own separate delete action).
 *
 * Uses the shared {@link FormDialog} shell so it matches the identity-provider
 * and roles create/edit dialogs: a title + description header, a scrollable
 * body, and a sticky footer.
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="App settings"
      description="Manage this app's details, tools, and who can use it."
    >
      {isPending ? (
        <>
          <DialogBody>
            <LoadingState
              className="min-h-40 flex-1"
              label="Loading app settings…"
              variant="compact"
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogStickyFooter>
        </>
      ) : isLoadingError ? (
        <>
          <DialogBody>
            <QueryLoadError
              title="Couldn't load app settings"
              onRetry={() => refetch()}
              className="min-h-40 flex-1"
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogStickyFooter>
        </>
      ) : app ? (
        <AppSettingsForm app={app} onBack={close} />
      ) : (
        <>
          <DialogBody>
            <output
              aria-label="App settings unavailable"
              className="flex min-h-40 flex-1 items-center justify-center text-sm text-muted-foreground"
            >
              App settings are unavailable.
            </output>
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogStickyFooter>
        </>
      )}
    </FormDialog>
  );
}
