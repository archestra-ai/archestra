"use client";

import { findUngrantablePermissions } from "@archestra/shared/access-control";
import { Loader2, ShieldAlert } from "lucide-react";
import { RoleOptionLabel } from "@/components/role-type-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
 * A reusable role selection dropdown that fetches roles from the API
 * and displays them with title-cased names.
 */
export function RoleSelect({
  value,
  onValueChange,
  placeholder = "Select role",
  disabled,
  "data-testid": testId,
  className,
  id,
  restrictToGrantable = true,
}: RoleSelectProps) {
  const { data: roles = [], isPending } = useRoles();
  const ungrantableFor = useUngrantablePermissions(restrictToGrantable);

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || isPending}
    >
      <SelectTrigger id={id} data-testid={testId} className={className}>
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => {
          const missing = ungrantableFor(role.permission);
          return (
            <SelectItem
              key={role.id}
              value={role.role}
              disabled={missing.length > 0}
            >
              <span className="flex flex-col items-start">
                <RoleOptionLabel
                  predefined={role.predefined}
                  label={toTitleCase(role.name)}
                />
                {missing.length > 0 ? (
                  <UngrantableHint missing={missing} />
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Just the SelectContent part for roles - use when you need custom trigger handling (e.g., with FormControl)
 */
export function RoleSelectContent({
  restrictToGrantable = true,
}: {
  restrictToGrantable?: boolean;
} = {}) {
  const { data: roles = [], isPending } = useRoles();
  const ungrantableFor = useUngrantablePermissions(restrictToGrantable);

  return (
    <SelectContent>
      {isPending ? (
        <div className="flex items-center justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        roles.map((role) => {
          const missing = ungrantableFor(role.permission);
          return (
            <SelectItem
              key={role.id}
              value={role.role}
              disabled={missing.length > 0}
            >
              <span className="flex flex-col items-start">
                <RoleOptionLabel
                  predefined={role.predefined}
                  label={toTitleCase(role.name)}
                />
                {missing.length > 0 ? (
                  <UngrantableHint missing={missing} />
                ) : null}
              </span>
            </SelectItem>
          );
        })
      )}
    </SelectContent>
  );
}
