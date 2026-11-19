"use client";

import { useState } from "react";
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
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type BulkRemoveConnectionsCopy,
  useBulkRemoveMcpConnections,
} from "@/lib/mcp/mcp-server.query";

export interface BulkRemoveConnection {
  id: string;
  /** What tells this connection from the others: its owner. */
  label: string;
  /** Shared with a team or the organization. */
  shared: boolean;
}

/** The words of a bulk removal: revoking credentials, uninstalling installations. */
export interface BulkRemoveCopy extends BulkRemoveConnectionsCopy {
  /** The action, as a button says it: "Revoke". */
  action: string;
  /** What removing them costs, in one sentence. */
  consequence: string;
  /** "service account" or "shared installation". */
  sharedNoun: string;
}

/**
 * From this many connections the confirmation asks for the action's word to
 * be typed: a selection that large is rarely ticked row by row, so a stray
 * click on "select all" must not be one more click away from removing it.
 */
const BULK_REMOVE_TYPE_TO_CONFIRM_FROM = 50;

const NAMES_SHOWN = 6;

export function BulkRemoveConnectionsDialog({
  open,
  onClose,
  connections,
  copy,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  connections: readonly BulkRemoveConnection[];
  copy: BulkRemoveCopy;
  /** Called once the removal has been attempted and reported. */
  onRemoved: () => void;
}) {
  const [typed, setTyped] = useState("");
  const removeMutation = useBulkRemoveMcpConnections();

  const count = connections.length;
  const plural = (n: number, noun: string) =>
    `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;
  const sharedCount = connections.filter(
    (connection) => connection.shared,
  ).length;
  const confirmWord = copy.failureVerb;
  const mustType = count >= BULK_REMOVE_TYPE_TO_CONFIRM_FROM;
  const ready =
    count > 0 && (!mustType || typed.trim().toLowerCase() === confirmWord);
  const busy = removeMutation.isPending;

  const close = () => {
    setTyped("");
    onClose();
  };
  const confirm = async () => {
    if (!ready || busy) return;
    await removeMutation.mutateAsync({
      connections: connections.map(({ id, label }) => ({ id, label })),
      copy,
    });
    setTyped("");
    onRemoved();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          <DialogTitle>
            {copy.action} {plural(count, copy.noun)}
          </DialogTitle>
        </DialogHeader>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={() => {
            void confirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>{copy.consequence}</DialogDescription>
            <ul className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {connections.slice(0, NAMES_SHOWN).map((connection) => (
                <li key={connection.id} className="truncate">
                  {connection.label}
                </li>
              ))}
              {count > NAMES_SHOWN ? (
                <li className="text-muted-foreground tabular-nums">
                  and {(count - NAMES_SHOWN).toLocaleString("en-US")} more
                </li>
              ) : null}
            </ul>
            {sharedCount > 0 ? (
              <InlineNotice>
                <span className="font-medium">
                  Includes {plural(sharedCount, copy.sharedNoun)}
                </span>
                <InlineNoticeText>
                  Everyone who relies on a shared one loses access with it.
                </InlineNoticeText>
              </InlineNotice>
            ) : null}
            {mustType ? (
              <div className="space-y-1.5">
                <Label
                  htmlFor="bulk-remove-confirm"
                  className="font-normal text-muted-foreground"
                >
                  <span>
                    Type{" "}
                    <span className="font-mono font-medium text-foreground">
                      {confirmWord}
                    </span>{" "}
                    to confirm
                  </span>
                </Label>
                <Input
                  id="bulk-remove-confirm"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={confirmWord}
                  autoCapitalize="off"
                  spellCheck={false}
                  autoFocus
                />
              </div>
            ) : null}
          </div>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!ready || busy}
            >
              {busy
                ? `${copy.action.replace(/e$/, "")}ing...`
                : `${copy.action} ${plural(count, copy.noun)}`}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
