// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { PermissionSubject } from "@archestra/shared";
import type { PermissionRecipient } from "@/lib/resource-permissions.query";

/**
 * Recipients sorted into the fixed sections every recipient picker shows:
 * Organization (everyone, then roles), Teams, People, Service accounts. Empty
 * sections are left out.
 */
export function groupPermissionRecipients(recipients: PermissionRecipient[]) {
  return GROUPS.map((group) => ({
    label: group.label,
    recipients: group.types.flatMap((type) =>
      recipients.filter((recipient) => recipient.subject.type === type),
    ),
  })).filter((group) => group.recipients.length > 0);
}

/** How a picker names a recipient: the organization and roles read as audiences. */
export function permissionRecipientLabel(recipient: PermissionRecipient) {
  if (recipient.subject.type === "organization")
    return "Everyone in the organization";
  if (recipient.subject.type === "role")
    return `Everyone with the ${recipient.name} role`;
  return recipient.name;
}

const GROUPS: Array<{ label: string; types: PermissionSubject["type"][] }> = [
  { label: "Organization", types: ["organization", "role"] },
  { label: "Teams", types: ["team"] },
  { label: "People", types: ["user"] },
  { label: "Service accounts", types: ["serviceAccount"] },
];
