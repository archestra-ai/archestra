"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { UserSearchableSelect } from "@/components/user-searchable-select";
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
    <StandardFormDialog
      open
      size="small"
      title="Transfer ownership"
      description={`Choose a new owner for ${agent.name}.`}
      onOpenChange={(open) => {
        if (!open && !transfer.isPending) onClose();
      }}
      onSubmit={() => {
        if (!ownerId || transfer.isPending || members.isError) return;
        transfer.mutate(
          { id: agent.id, ownerId },
          { onSuccess: onTransferred },
        );
      }}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={transfer.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!ownerId || transfer.isPending || members.isError}
          >
            {transfer.isPending ? "Transferring…" : "Transfer ownership"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="transfer-agent-owner">New owner</Label>
        <UserSearchableSelect
          id="transfer-agent-owner"
          ariaLabel="New owner"
          className="w-full"
          value={ownerId}
          onValueChange={setOwnerId}
          placeholder={
            members.isPending ? "Loading users…" : "Select new owner"
          }
          searchPlaceholder="Search users…"
          disabled={members.isPending || transfer.isPending}
          users={(members.data ?? [])
            .filter((member) => member.id !== agent.authorId)
            .map((member) => ({
              userId: member.id,
              name: member.name,
              email: member.email,
            }))}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Configuration and sharing settings stay the same.
        {agent.scope === "personal" && (
          <span> You may lose access after transferring ownership.</span>
        )}
      </p>
      {members.isError && (
        <p role="alert">
          Unable to load users.{" "}
          <Button
            type="button"
            variant="link"
            onClick={() => members.refetch()}
          >
            Retry
          </Button>
        </p>
      )}
    </StandardFormDialog>
  );
}
