import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import type { ExecutionCredentialDefinition } from "@/lib/execution-credentials.query";

export function ExecutionCredentialDisconnectDialog({
  definition,
  scope,
  open,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  definition: ExecutionCredentialDefinition | null;
  scope: "personal" | "organization";
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const impact =
    scope === "personal"
      ? "Background executions you start will no longer be able to use this connection."
      : "Background executions for every Agent bound to this organization connection will stop using it.";

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Disconnect ${definition?.name ?? "credential"}?`}
      description={impact}
      confirmLabel="Disconnect"
      pendingLabel="Disconnecting..."
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
