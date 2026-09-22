// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ScopedResource } from "@archestra/shared";
import { ResourcePermissionsDialog } from "@/components/resource-permissions";

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
  return (
    <ResourcePermissionsDialog
      resource={resource}
      scope={scope}
      title={title}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
