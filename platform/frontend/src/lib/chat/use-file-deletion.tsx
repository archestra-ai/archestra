"use client";

import { type ReactNode, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";

/** A file the deletion flow can act on: identified, named, and removable. */
type DeletableFile = { id: string; name: string };

/**
 * The shared delete-confirm flow for the Files panels: opens a confirm dialog,
 * runs the caller's `deleteItems`, and reports the ids that failed so the call
 * site can reconcile its own state (keep failed rows selected, stay on a still-
 * present open file). `deleteItems` owns the actual deletes, toasts, and cache
 * invalidation; this hook owns only the confirm UI and the count-based title.
 */
export function useFileDeletion<T extends DeletableFile>({
  deleteItems,
  describe,
}: {
  deleteItems: (items: T[]) => Promise<{ failedIds: string[] }>;
  /** Confirm-dialog body for the given items (e.g. a shared-file warning). */
  describe?: (items: T[]) => string;
}): {
  requestDelete: (
    items: T[],
    onComplete?: (failedIds: string[]) => void,
  ) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{
    items: T[];
    onComplete?: (failedIds: string[]) => void;
  } | null>(null);
  const [isPending, setIsPending] = useState(false);

  const requestDelete = (
    items: T[],
    onComplete?: (failedIds: string[]) => void,
  ) => {
    if (items.length > 0) setPending({ items, onComplete });
  };

  const handleConfirm = async () => {
    if (!pending) return;
    const { items, onComplete } = pending;
    setIsPending(true);
    try {
      const { failedIds } = await deleteItems(items);
      setPending(null);
      onComplete?.(failedIds);
    } finally {
      setIsPending(false);
    }
  };

  const count = pending?.items.length ?? 0;
  const dialog = (
    <DeleteConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={
        count === 1
          ? `Delete “${pending?.items[0]?.name}”?`
          : `Delete ${count} files?`
      }
      description={
        pending ? (describe?.(pending.items) ?? "This can't be undone.") : ""
      }
      isPending={isPending}
      onConfirm={handleConfirm}
    />
  );

  return { requestDelete, dialog };
}
