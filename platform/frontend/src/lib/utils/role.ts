// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { getFixedRole } from "@archestra/shared/fixed-roles";

/**
 * A role identifier as a human label: `custom_read-only` becomes
 * `Custom Read Only`.
 *
 * Fixed roles (`fixed:agents:reader`) carry their own display name.
 *
 * Roles are stored as free-form identifiers, so both the screens that show one
 * to a person had grown their own copy of this. Splitting on every separator
 * and dropping empties keeps a leading or doubled separator from producing a
 * stray capitalised gap.
 */
export function formatRoleName(role: string): string {
  if (role.includes(","))
    return role
      .split(",")
      .map((part) => formatRoleName(part.trim()))
      .join(", ");
  const fixed = getFixedRole(role);
  if (fixed) return fixed.name;
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
