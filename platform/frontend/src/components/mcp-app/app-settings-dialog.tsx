"use client";

import { useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { AppSettingsForm } from "@/components/mcp-app/app-settings-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/lib/app.query";

// Ties the footer's Save button to the settings form via the HTML `form` attr.
// Only one settings dialog is open at a time, so a single id is safe.
const APP_SETTINGS_FORM_ID = "app-settings-form";

/**
 * The one app-settings surface, opened from both the apps-page cards and the
 * chat side-panel header. Loads the full app by id and hosts {@link AppSettingsForm}
 * with a Save button wired to it; delete is intentionally not here (each host
 * owns its own separate delete action).
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
  const { data: app } = useApp(open ? appId : null);
  const [status, setStatus] = useState({ saving: false, disabled: false });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-2xl flex-col gap-0 p-0 pt-0">
        <DialogHeader className="px-4 py-4">
          <DialogTitle>App settings</DialogTitle>
        </DialogHeader>
        {app ? (
          <AppSettingsForm
            app={app}
            formId={APP_SETTINGS_FORM_ID}
            onBack={() => onOpenChange(false)}
            onStatusChange={setStatus}
          />
        ) : (
          <div className="flex min-h-40 flex-1 items-center justify-center">
            <LoadingSpinner />
          </div>
        )}
        <DialogFooter className="px-4 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={APP_SETTINGS_FORM_ID}
            disabled={!app || status.disabled}
          >
            {status.saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
