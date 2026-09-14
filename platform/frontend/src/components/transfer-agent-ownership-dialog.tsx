"use client";
import type { archestraApiTypes } from "@archestra/shared";
import { TransferOwnershipDialog } from "@/components/transfer-ownership-dialog";
import { useTransferAgentOwnership } from "@/lib/agent.query";

export function TransferAgentOwnershipDialog({
  agent,
  onClose,
  onTransferred,
}: {
  agent: Pick<
    archestraApiTypes.GetAgentResponses["200"],
    "id" | "name" | "authorId" | "scope"
  >;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const transfer = useTransferAgentOwnership();
  return (
    <TransferOwnershipDialog
      resource={agent}
      transfer={transfer}
      onClose={onClose}
      onTransferred={onTransferred}
    />
  );
}
