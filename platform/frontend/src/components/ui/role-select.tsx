"use client";

import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
}: RoleSelectProps) {
  const { data: roles = [], isPending } = useRoles();

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
        {roles.map((role) => (
          <SelectItem key={role.id} value={role.role}>
            {toTitleCase(role.name)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Just the SelectContent part for roles - use when you need custom trigger handling (e.g., with FormControl)
 */
export function RoleSelectContent() {
  const { data: roles = [], isPending } = useRoles();

  return (
    <SelectContent>
      {isPending ? (
        <div className="flex items-center justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        roles.map((role) => (
          <SelectItem key={role.id} value={role.role}>
            {toTitleCase(role.name)}
          </SelectItem>
        ))
      )}
    </SelectContent>
  );
}
