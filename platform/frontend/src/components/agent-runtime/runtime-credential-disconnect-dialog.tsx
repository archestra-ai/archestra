import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";

export function RuntimeCredentialDisconnectDialog({
  definition,
  scope,
  open,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  definition: RuntimeCredentialDefinition | null;
  scope: "personal" | "organization";
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const impact =
    scope === "personal"
      ? "Agent Runtime runs you start will no longer be able to use this connection."
      : "Agent Runtime runs for every Agent bound to this organization connection will stop using it.";

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
