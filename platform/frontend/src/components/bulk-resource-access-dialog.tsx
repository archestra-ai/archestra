// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ScopedResource } from "@archestra/shared";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { useAddBulkResourceAccess } from "@/lib/resource-permissions.query";

/** Additive sharing preserves every existing recipient and the resource owner. */
export function BulkResourceAccessDialog({
  resource,
  items,
  open,
  onOpenChange,
  onApplied,
  isLoading = false,
  loadError,
  onRetry,
}: {
  resource: ScopedResource;
  items: readonly { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: () => void;
  isLoading?: boolean;
  loadError?: Error | null;
  onRetry?: () => void;
}) {
  const [grants, setGrants] = useState<InitialPermissionGrant[]>([]);
  const addAccess = useAddBulkResourceAccess(resource);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add access"
      description={`Add permissions to ${items.length} selected resources. Existing access is preserved.`}
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadError ? (
          <QueryLoadError
            title="Could not load selected documents"
            onRetry={() => onRetry?.()}
          />
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading selected documents…
          </p>
        ) : (
          <InitialResourcePermissions
            resource={resource}
            scope={items[0]?.id}
            grants={grants}
            onChange={setGrants}
          />
        )}
      </div>
      <DialogStickyFooter>
        <Button
          variant="outline"
          disabled={addAccess.isPending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          disabled={
            !grants.length ||
            !items.length ||
            addAccess.isPending ||
            isLoading ||
            !!loadError
          }
          onClick={() =>
            addAccess.mutate(
              { items, grants },
              {
                onSuccess: (outcome) => {
                  if (outcome.failed.length === 0) {
                    onApplied?.();
                    onOpenChange(false);
                  }
                },
              },
            )
          }
        >
          {addAccess.isPending ? "Applying…" : "Apply"}
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
