// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ScopedResource } from "@archestra/shared";
import { useState } from "react";
import { ResourcePermissions } from "@/components/resource-permissions";
import { StandardDialog } from "@/components/standard-dialog";

export function ResourcePermissionDialog({
  resource,
  scope,
  title,
  open,
  onOpenChange,
}: {
  resource: ScopedResource;
  scope: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isDirty, setIsDirty] = useState(false);
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="large"
      isDirty={isDirty}
    >
      {open && (
        <ResourcePermissions
          resource={resource}
          scope={scope}
          onDirtyChange={setIsDirty}
        />
      )}
    </StandardDialog>
  );
}
