"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useTransferAgentOwnership } from "@/lib/agent.query";
import { useOrganizationMembers } from "@/lib/organization.query";

type TransferAgent = Pick<
  archestraApiTypes.GetAgentResponses["200"],
  "id" | "name" | "authorId" | "scope"
>;

export function TransferAgentOwnershipDialog({
  agent,
  onClose,
  onTransferred,
}: {
  agent: TransferAgent;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const [ownerId, setOwnerId] = useState("");
  const members = useOrganizationMembers();
  const transfer = useTransferAgentOwnership();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !transfer.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>
            Choose a new owner for {agent.name}. Its configuration and sharing
            settings stay the same.
            {agent.scope === "personal" && (
              <span> You may lose access after transferring ownership.</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <SearchableSelect
          ariaLabel="New owner"
          value={ownerId}
          onValueChange={setOwnerId}
          placeholder={
            members.isPending ? "Loading users…" : "Select new owner"
          }
          searchPlaceholder="Search users…"
          disabled={members.isPending || transfer.isPending}
          items={(members.data ?? [])
            .filter((member) => member.id !== agent.authorId)
            .map((member) => ({
              value: member.id,
              label: member.name,
              description: member.email,
            }))}
        />
        {members.isError && (
          <p role="alert">
            Unable to load users.{" "}
            <Button variant="link" onClick={() => members.refetch()}>
              Retry
            </Button>
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={transfer.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={!ownerId || transfer.isPending || members.isError}
            onClick={() =>
              transfer.mutate(
                { id: agent.id, ownerId },
                { onSuccess: onTransferred },
              )
            }
          >
            {transfer.isPending ? "Transferring…" : "Transfer ownership"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
