// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ScopedResource } from "@archestra/shared";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { ResourcePermissions } from "@/components/resource-permissions";

/**
 * The one place a form asks "who can reach this".
 *
 * Every resource used to answer that with a visibility enum plus a team or
 * user list, and each form drew its own. Access is a grant now, so the
 * question has one answer and one control, and the only thing that varies is
 * whether the object exists yet.
 *
 * A form that creates something has nothing to attach grants to, so it
 * collects them and submits them with the resource. A form that edits
 * something reads and writes the object's real policy.
 */
export function ResourceAccessSection({
  resource,
  id,
  grants,
  onGrantsChange,
  onDirtyChange,
}: {
  resource: ScopedResource;
  /** Omitted while the object is still being created. */
  id?: string;
  grants?: InitialPermissionGrant[];
  onGrantsChange?: (grants: InitialPermissionGrant[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  if (!id)
    return (
      <InitialResourcePermissions
        resource={resource}
        grants={grants ?? []}
        onChange={onGrantsChange ?? (() => {})}
      />
    );
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Permissions</h3>
      <ResourcePermissions
        resource={resource}
        scope={id}
        onDirtyChange={onDirtyChange}
        embedded
      />
    </div>
  );
}
