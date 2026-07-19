"use client";

import { Users } from "lucide-react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";

export interface PersonalCredentialPin {
  mcpName: string;
  ownerEmail: string;
  /** The chosen connection belongs to the person making the change. */
  isCurrentUser: boolean;
}

interface StaticCredentialConfirmDialogProps {
  open: boolean;
  pins: PersonalCredentialPin[];
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * "agent" (default): a connection chosen for one agent's tools. "server": the
   * server's default connection, used by every agent that resolves it at call
   * time.
   */
  context?: "agent" | "server";
}

const asWho = (pin: PersonalCredentialPin) =>
  pin.isCurrentUser ? "you" : pin.ownerEmail;
const possessiveWho = (pin: PersonalCredentialPin) =>
  pin.isCurrentUser ? "your" : `${pin.ownerEmail}'s`;

export function StaticCredentialConfirmDialog({
  open,
  pins,
  onConfirm,
  onCancel,
  context = "agent",
}: StaticCredentialConfirmDialogProps) {
  const single = pins.length === 1 ? pins[0] : null;

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
          <span>
            {single
              ? "Use this connection for everyone?"
              : "Use these connections for everyone?"}
          </span>
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
            {single ? "Use this connection" : "Use these connections"}
          </Button>
        </>
      }
    >
      {single ? (
        <p className="text-sm text-muted-foreground">
          {context === "server" ? (
            <>
              Every agent that resolves{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>{" "}
              at call time will connect as{" "}
              <span className="text-foreground font-medium">
                {asWho(single)}
              </span>
              , no matter who is calling — using {possessiveWho(single)} access
              and rate limits.
            </>
          ) : (
            <>
              Every user of this agent will connect to{" "}
              <span className="text-foreground font-medium">
                {single.mcpName}
              </span>{" "}
              as{" "}
              <span className="text-foreground font-medium">
                {asWho(single)}
              </span>
              , no matter who is calling — using {possessiveWho(single)} access
              and rate limits.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Every user of this agent will connect to these servers as the person
            shown, no matter who is calling:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {pins.map((pin) => (
              <li key={`${pin.mcpName}:${pin.ownerEmail}`}>
                <span className="text-foreground font-medium">
                  {pin.mcpName}
                </span>{" "}
                as {asWho(pin)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </StandardDialog>
  );
}
