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
import { typeRole } from "@/lib/design/type-scale";
import {
  type MutableAlertKind,
  useMuteMcpServerAlert,
} from "@/lib/mcp/mcp-server.query";
import { getMcpServerIssueKindMeta } from "@/lib/mcp/mcp-server-issues";

/**
 * Muting an alert takes it out of the viewer's own counts, and out of nobody
 * else's. The reason is required because a silenced alert with no note is
 * indistinguishable from an alert nobody noticed: it comes back to the muting
 * user on the row they silenced, and it is the one durable record of why the
 * alert stopped counting, in the audit log.
 *
 * The note is deliberately not promised to colleagues. `GET /api/mcp_server`
 * returns only the caller's own mutes, so no other viewer can be shown it, and
 * telling people otherwise would invite them to leave handover notes nobody
 * ever reads.
 */
export function MuteAlertDialog({
  open,
  onClose,
  server,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  server: { id: string; name: string } | null;
  kind: MutableAlertKind;
}) {
  const [reason, setReason] = useState("");
  const muteMutation = useMuteMcpServerAlert();
  const label = getMcpServerIssueKindMeta(kind).label.toLowerCase();

  // A dialog reused across rows would otherwise open carrying the note the
  // viewer typed for a different connection.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const handleConfirm = async () => {
    if (!server || !reason.trim()) return;
    const muted = await muteMutation.mutateAsync({
      serverId: server.id,
      serverName: server.name,
      kind,
      reason: reason.trim(),
    });
    if (muted) onClose();
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
          <DialogTitle>Mute this alert</DialogTitle>
        </DialogHeader>
        <DialogForm
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>
              "{server?.name}" stops counting as {label} for you. Everybody else
              keeps seeing it, and it comes back on its own if the connection
              fails again for a new reason.
            </DialogDescription>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mute-alert-reason">Why are you muting it?</Label>
              <Textarea
                id="mute-alert-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Owner is on leave until the 14th"
                rows={3}
                required
              />
              <p className={typeRole({ role: "meta" })}>
                Shown back to you on the muted alert, and recorded in the audit
                log.
              </p>
            </div>
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!reason.trim() || muteMutation.isPending}
            >
              {muteMutation.isPending ? "Muting…" : "Mute"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
