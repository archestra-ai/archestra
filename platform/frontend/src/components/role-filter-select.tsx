"use client";

import { FilterSelect } from "@/components/filter-bar";
import { useRoles } from "@/lib/role.query";
import { formatRoleName } from "@/lib/utils/role";

/**
 * The "Filter by role" control for a table of things that carry an
 * organization role.
 *
 * The list comes from {@link useRoles}, the same query the role *pickers* read,
 * rather than from the rows on screen. A filter built from the visible rows can
 * only offer roles that are already in use, so a custom role nobody has been
 * given yet is missing from the very filter you would use to check that.
 *
 * Unlike `RoleSelect` this does not hide or disable roles the viewer cannot
 * grant: narrowing a list is not granting anything, and a role you may not
 * assign is still one you may need to audit.
 */
export function RoleFilterSelect({
  value,
  onValueChange,
  allOptionValue = "all",
}: {
  /** The selected role, or `allOptionValue` when not filtered. */
  value: string;
  onValueChange: (value: string) => void;
  allOptionValue?: string;
}) {
  // Errors stay silent: this sits beside a table that renders its own load
  // state, and a role list we could not read costs the dropdown, not the page.
  const { data: roles = [] } = useRoles();

  return (
    <FilterSelect
      value={value}
      onValueChange={onValueChange}
      inactiveValue={allOptionValue}
      placeholder="Filter by role"
      items={[
        { value: allOptionValue, label: "All roles" },
        ...roles.map((role) => ({
          value: role.role,
          label: formatRoleName(role.name),
        })),
      ]}
    />
  );
}
