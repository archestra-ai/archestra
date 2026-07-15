"use client";

import { Users } from "lucide-react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { useAppName } from "@/lib/hooks/use-app-name";

export interface PersonalCredentialPin {
  mcpName: string;
  ownerEmail: string;
  /** The pinned connection belongs to the person doing the pinning. */
  isCurrentUser: boolean;
}

interface StaticCredentialConfirmDialogProps {
  open: boolean;
  pins: PersonalCredentialPin[];
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * "agent" (default): pinning a connection to one agent's tools. "server": the
   * server's default credential, which applies to every agent that resolves it
   * at call time.
   */
  context?: "agent" | "server";
}

export function StaticCredentialConfirmDialog({
  open,
  pins,
  onConfirm,
  onCancel,
  context = "agent",
}: StaticCredentialConfirmDialogProps) {
  const appName = useAppName();
  const single = pins.length === 1 ? pins[0] : null;

  const confirmLabel = single
    ? context === "server"
      ? single.isCurrentUser
        ? "Use your account"
        : `Use ${single.ownerEmail}'s account`
      : single.isCurrentUser
        ? "Pin to your connection"
        : `Pin to ${single.ownerEmail}'s connection`
    : "Pin anyway";

  // A plain (non-form) dialog: this renders inside a modal's own form, and a
  // nested submit would bubble through the React portal to that form and
  // save/close the whole modal. `type="button"` + stopPropagation keep the
  // confirm contained. Cancel comes first so it takes initial focus.
  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          <span>Pin every user to a personal account?</span>
        </div>
      }
      size="small"
      footer={
        <>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {single ? (
        <p className="text-sm text-muted-foreground">
          {context === "server" ? (
            single.isCurrentUser ? (
              <>
                Set as the default, every agent that resolves{" "}
                <span className="text-foreground font-medium">
                  {single.mcpName}
                </span>{" "}
                at call time connects as{" "}
                <span className="text-foreground font-medium">you</span> — every
                caller's request comes from you, with your access, against your
                rate limits, and under your name.
              </>
            ) : (
              <>
                Set as the default, every agent that resolves{" "}
                <span className="text-foreground font-medium">
                  {single.mcpName}
                </span>{" "}
                at call time connects as{" "}
                <span className="text-foreground font-medium">
                  {single.ownerEmail}
                </span>{" "}
                — every caller's request comes from {single.ownerEmail}, with
                their access, against their rate limits, and under their name.
              </>
            )
          ) : single.isCurrentUser ? (
            <>
              Everyone who uses this agent will call{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>{" "}
              through <span className="text-foreground font-medium">your</span>{" "}
              connection. To{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>
              , every request comes from you — with your access, against your
              rate limits, and under your name.
            </>
          ) : (
            <>
              Everyone who uses this agent will call{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>{" "}
              through{" "}
              <span className="text-foreground font-medium">
                {single.ownerEmail}
              </span>
              's connection. To{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>
              , every request comes from {single.ownerEmail} — with their
              access, against their rate limits, and under their name.
            </>
          )}{" "}
          {appName}'s own tool-call log still records who actually ran each
          call.
        </p>
      ) : (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Sharing this agent pins its tools to personal connections. Everyone
            who uses it will call each server as that one owner — with their
            access, rate limits, and name:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {pins.map((pin) => (
              <li key={`${pin.mcpName}:${pin.ownerEmail}`}>
                <span className="text-foreground font-medium">
                  {pin.mcpName}
                </span>{" "}
                as {pin.isCurrentUser ? "you" : pin.ownerEmail}
              </li>
            ))}
          </ul>
          <p>
            {appName}'s own tool-call log still records who actually ran each
            call.
          </p>
        </div>
      )}
    </StandardDialog>
  );
}
