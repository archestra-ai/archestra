// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissions } from "@/lib/resource-permissions.query";

/**
 * Evaluates synthetic MSW policies for the UI preview. Real policies need a
 * server assessment of effective access and active managers before enforcement.
 * Without the mock actor subjects this adds no permission restrictions.
 */
export function getPermissionSafetyPreview({
  policy,
  grants,
}: {
  policy: ResourcePermissions;
  grants: ResourcePermissions["grants"];
}) {
  if (!policy.previewActorSubjects) return null;
  const applicable = [...grants, ...policy.inheritedGrants];
  const ownGrants = applicable.filter((grant) =>
    policy.previewActorSubjects?.some(
      (subject) =>
        subject.type === grant.subject.type && subject.id === grant.subject.id,
    ),
  );
  const managers = applicable.filter((grant) =>
    grant.actions.includes("manage-permissions"),
  );
  return {
    blocked: managers.length === 0,
    losesAccess: !ownGrants.some((grant) => grant.actions.includes("read")),
    losesManagement: !ownGrants.some((grant) =>
      grant.actions.includes("manage-permissions"),
    ),
    recovery: managers.map((grant) => grant.name).join(", "),
  };
}
