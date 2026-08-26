/**
 * A role identifier as a human label: `custom_read-only` becomes
 * `Custom Read Only`.
 *
 * Roles are stored as free-form identifiers, so both the screens that show one
 * to a person had grown their own copy of this. Splitting on every separator
 * and dropping empties keeps a leading or doubled separator from producing a
 * stray capitalised gap.
 */
export function formatRoleName(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
