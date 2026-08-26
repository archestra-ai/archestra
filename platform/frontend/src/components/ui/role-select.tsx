"use client";

import { findUngrantablePermissions } from "@archestra/shared/access-control";
import { ShieldAlert } from "lucide-react";
import type * as React from "react";
import { RoleOptionLabel } from "@/components/role-type-icon";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRoles } from "@/lib/role.query";

/**
 * Converts a string to title case, splitting on hyphens, underscores, and spaces.
 */
function toTitleCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

interface RoleSelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** data-testid attribute */
  "data-testid"?: string;
  /** Additional class name for the trigger */
  className?: string;
  /** ID for the select trigger */
  id?: string;
  /**
   * Accessible name for the trigger, for pickers with no `<Label htmlFor>` of
   * their own — `role="combobox"` takes its name from the author rather than
   * from the trigger's contents.
   */
  ariaLabel?: string;
  /** Forwarded to the trigger by a `FormControl` wrapper. */
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  /**
   * When true (default), roles carrying permissions the current user does not
   * hold are disabled with an explanation — the server enforces the same
   * no-escalation rule on every grant path, so offering them would only lead
   * to a rejection. Turn off for pickers that CONFIGURE a mapping rather than
   * grant a role (e.g. identity-provider role mappings, applied by the IdP).
   */
  restrictToGrantable?: boolean;
}

/** `resource:action` pairs the current user can't grant for a role, or [] when unrestricted/loading. */
function useUngrantablePermissions(enabled: boolean) {
  const { data: userPermissions } = useAllPermissions();
  if (!enabled || !userPermissions) return () => [] as string[];
  return (rolePermission: Record<string, string[]> | undefined) =>
    rolePermission
      ? findUngrantablePermissions(userPermissions, rolePermission)
      : [];
}

function UngrantableHint({ missing }: { missing: string[] }) {
  const shown = missing.slice(0, 2).join(", ");
  const more = missing.length - 2;
  return (
    <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      <ShieldAlert className="h-3 w-3 shrink-0" />
      <span>
        Grants permissions you don't hold: {shown}
        {more > 0 ? <span> and {more} more</span> : null}
      </span>
    </span>
  );
}

/**
 * The role picker, searchable like the platform's other pickers over a list
 * that has no fixed ceiling: an organization can define as many custom roles
 * as it likes, and scrolling a flat list to find one stops working long before
 * that. Search covers the role's display name and its identifier, since the
 * identifier is what the API and the IdP mappings speak in.
 */
export function RoleSelect({
  value,
  onValueChange,
  placeholder = "Select role",
  disabled,
  "data-testid": testId,
  className,
  id,
  ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  restrictToGrantable = true,
}: RoleSelectProps) {
  const { data: roles = [], isPending } = useRoles();
  const ungrantableFor = useUngrantablePermissions(restrictToGrantable);

  const items = roles.map((role) => {
    const missing = ungrantableFor(role.permission);
    const label = toTitleCase(role.name);
    return {
      value: role.role,
      label,
      // The identifier is what an admin sees in the API and in IdP mappings,
      // so a search for it should find the role even when the display name
      // has been edited away from it.
      searchText: `${label} ${role.name} ${role.role}`,
      disabled: missing.length > 0,
      content: (
        <span className="flex flex-col items-start">
          <RoleOptionLabel predefined={role.predefined} label={label} />
          {missing.length > 0 ? <UngrantableHint missing={missing} /> : null}
        </span>
      ),
      // The trigger shows the role alone: the hint explains why an option is
      // unpickable, which a picked role by definition wasn't.
      selectedContent: (
        <RoleOptionLabel predefined={role.predefined} label={label} />
      ),
    };
  });

  return (
    <SearchableSelect
      value={value ?? ""}
      onValueChange={(role) => onValueChange?.(role)}
      id={id}
      ariaLabel={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-testid={testId}
      className={className}
      disabled={disabled || isPending}
      placeholder={isPending ? "Loading roles…" : placeholder}
      searchPlaceholder="Search roles..."
      emptyMessage="No matching roles found."
      items={items}
    />
  );
}
