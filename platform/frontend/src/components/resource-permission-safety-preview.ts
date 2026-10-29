// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissions } from "@/lib/resource-permissions.query";

/**
 * What an unsaved edit would do to the caller and to the policy. The server
 * refuses a save that leaves nobody managing; this lets the editor say so
 * before the save, and warn the caller before they give up their own access.
 */
export function getPermissionSafetyPreview({
  policy,
  grants,
}: {
  policy: ResourcePermissions;
  grants: ResourcePermissions["grants"];
}) {
  if (!policy.actorSubjects.length) return null;
  const applicable = [...grants, ...policy.inheritedGrants];
  const ownGrants = applicable.filter((grant) =>
    policy.actorSubjects.some(
      (subject) =>
        subject.type === grant.subject.type && subject.id === grant.subject.id,
    ),
  );
  const managers = applicable.filter((grant) =>
    grant.actions.includes("manage-permissions"),
  );
  // Mirrors the server: only a save that removes the last manager is refused.
  const managedBefore = [...policy.grants, ...policy.inheritedGrants].some(
    (grant) => grant.actions.includes("manage-permissions"),
  );
  return {
    blocked: managedBefore && managers.length === 0,
    losesAccess: !ownGrants.some((grant) => grant.actions.includes("read")),
    losesManagement: !ownGrants.some((grant) =>
      grant.actions.includes("manage-permissions"),
    ),
    recovery: managers.map((grant) => grant.name).join(", "),
  };
}
