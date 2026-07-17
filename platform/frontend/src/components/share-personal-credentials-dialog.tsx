"use client";

import { Users } from "lucide-react";
import { StandardDialog } from "@/components/standard-dialog";
import type { PersonalCredentialPin } from "@/components/static-credential-confirm-dialog";
import { Button } from "@/components/ui/button";

interface SharePersonalCredentialsDialogProps {
  open: boolean;
  pins: PersonalCredentialPin[];
  /** Switch the pinned connections to resolve-at-call-time, then save (safe default). */
  onResolveDynamic: () => void;
  /** Keep the personal pins and share them with everyone, then save. */
  onShareAsIs: () => void;
  /** Dismiss without saving. */
  onCancel: () => void;
}

const asWho = (pin: PersonalCredentialPin) =>
  pin.isCurrentUser ? "you" : pin.ownerEmail;

/**
 * Confirms scoping an agent up (personal → team/org) while it still pins personal
 * connections. Cancel renders first so it takes initial focus — a reflexive Enter
 * dismisses rather than shares. "Resolve at call time" is the visually primary,
 * recommended action; "Share as-is" is the deliberate opt-in to sharing.
 */
export function SharePersonalCredentialsDialog({
  open,
  pins,
  onResolveDynamic,
  onShareAsIs,
  onCancel,
}: SharePersonalCredentialsDialogProps) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          <span>Share these connections with everyone?</span>
        </div>
      }
      size="small"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onShareAsIs();
            }}
          >
            Share as-is
          </Button>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onResolveDynamic();
            }}
          >
            Resolve at call time
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Every user of this agent will connect as the person shown, no matter
          who is calling:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {pins.map((pin) => (
            <li key={`${pin.mcpName}:${pin.ownerEmail}`}>
              <span className="text-foreground font-medium">{pin.mcpName}</span>{" "}
              as {asWho(pin)}
            </li>
          ))}
        </ul>
        <p>
          Resolve at call time instead to let each user connect with their own
          connection.
        </p>
      </div>
    </StandardDialog>
  );
}
