"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type DismissibleMcpAlert,
  useDismissMcpServerAlerts,
} from "@/lib/mcp/mcp-server.query";
import { MCP_SERVER_ISSUE_KINDS } from "@/lib/mcp/mcp-server-issues";

export type DismissAlertTarget = DismissibleMcpAlert;

/**
 * Dismissing an alert removes it from the viewer's own queue and nobody
 * else's. An optional note can be applied to one alert or a bulk selection.
 */
export function DismissAlertDialog({
  open,
  onClose,
  targets,
  onDismissed,
}: {
  open: boolean;
  onClose: () => void;
  targets: readonly DismissAlertTarget[];
  onDismissed?: (targets: DismissAlertTarget[]) => void;
}) {
  const [reason, setReason] = useState("");
  const dismissMutation = useDismissMcpServerAlerts();
  const targetCount = targets.length;
  const singleTarget = targets[0];
  // The target type keeps legacy kinds a dismissal may have been stored
  // under; anything the live taxonomy no longer names is just "alert".
  const label = singleTarget
    ? (
        MCP_SERVER_ISSUE_KINDS.find((meta) => meta.kind === singleTarget.kind)
          ?.label ?? "alert"
      ).toLowerCase()
    : "alert";

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const handleConfirm = async () => {
    if (targetCount === 0) return;
    const trimmedReason = reason.trim();
    const result = await dismissMutation.mutateAsync({
      alerts: [...targets],
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    });
    if (result.succeeded.length > 0) {
      onDismissed?.(result.succeeded);
    }
    if (result.failed.length === 0) {
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader className="border-b-0">
          <DialogTitle>
            {targetCount === 1 ? "Dismiss alert" : "Dismiss alerts"}
          </DialogTitle>
        </DialogHeader>
        <DialogForm
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>
              {targetCount === 1 ? (
                <>
                  Dismiss the {label} alert for "
                  {singleTarget?.serverName ?? singleTarget?.catalogName}" from
                  your queue. This affects only you.
                </>
              ) : (
                <>
                  Dismiss {targetCount} alerts from your queue. This affects
                  only you.
                </>
              )}
            </DialogDescription>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dismiss-alert-reason">Reason (optional)</Label>
              <Textarea
                id="dismiss-alert-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add a note"
                rows={3}
              />
            </div>
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={targetCount === 0 || dismissMutation.isPending}
            >
              {dismissMutation.isPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
