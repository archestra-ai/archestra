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
  registerSave,
  standalone,
}: {
  resource: ScopedResource;
  /** Omitted while the object is still being created. */
  id?: string;
  grants?: InitialPermissionGrant[];
  onGrantsChange?: (grants: InitialPermissionGrant[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Pass this from a form that has its own Save. The section then hides its
   * own Save and Discard, and the form commits the policy by calling the
   * function it receives here. Without it the section saves itself.
   */
  registerSave?: (save: (() => Promise<void>) | null) => void;
  /** Set when the section is a tab pane of its own, not one field among many. */
  standalone?: boolean;
}) {
  if (!id)
    return (
      <InitialResourcePermissions
        resource={resource}
        grants={grants ?? []}
        onChange={onGrantsChange ?? (() => {})}
      />
    );
  // The panel carries the one heading. A second "Who has access" above the
  // same list said nothing the list did not already show.
  return (
    <ResourcePermissions
      resource={resource}
      scope={id}
      onDirtyChange={onDirtyChange}
      registerSave={registerSave}
      standalone={standalone}
      title="Permissions"
      embedded
    />
  );
}
