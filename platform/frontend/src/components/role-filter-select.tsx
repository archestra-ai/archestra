"use client";

import { FilterSelect } from "@/components/filter-bar";
import { RoleOptionLabel } from "@/components/role-type-icon";
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
 * Rows are drawn with `RoleOptionLabel`, so a role reads the same here as it
 * does in `RoleSelect` and in the table cells this filters — predefined and
 * custom roles are told apart by the same icon everywhere. What it does *not*
 * reuse is `RoleSelect` itself: that is a picker for *granting* a role, so it
 * disables the ones the viewer may not grant, and narrowing a list is not
 * granting anything — a role you may not assign is still one you may need to
 * audit.
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
      searchPlaceholder="Search roles..."
      emptyMessage="No matching roles found."
      // Pinned rather than listed: clearing the filter is the way back out of a
      // search, so the option that does it must survive the search that made it
      // necessary.
      pinnedItems={[
        {
          value: allOptionValue,
          label: "All roles",
          // Indented past an icon it doesn't have, so its label lines up with
          // the roles beneath it. "All roles" is not a role, and borrowing
          // either role icon for it would claim it is a kind of one.
          content: (
            <span className="flex items-center gap-2">
              <span aria-hidden className="h-4 w-4 shrink-0" />
              All roles
            </span>
          ),
        },
      ]}
      items={roles.map((role) => {
        const label = formatRoleName(role.name);
        return {
          value: role.role,
          label,
          // The identifier is what the API and the IdP mappings speak in, so a
          // search for it should find the role even once the display name has
          // been edited away from it.
          searchText: `${label} ${role.name} ${role.role}`,
          content: (
            <RoleOptionLabel predefined={role.predefined} label={label} />
          ),
        };
      })}
    />
  );
}
