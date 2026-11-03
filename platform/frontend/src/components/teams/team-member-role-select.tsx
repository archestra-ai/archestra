"use client";

import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TeamMemberRole = typeof ADMIN_ROLE_NAME | typeof MEMBER_ROLE_NAME;

/** Team Admin/Member picker, with what each role can do under its name. */
export function TeamMemberRoleSelect({
  value,
  onChange,
  ariaLabel,
  size = "default",
  className,
  disabled,
}: {
  value: TeamMemberRole;
  onChange: (role: TeamMemberRole) => void;
  ariaLabel: string;
  size?: "sm" | "default";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as TeamMemberRole)}
      disabled={disabled}
    >
      <SelectTrigger size={size} aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="w-64">
        <SelectItem
          value={ADMIN_ROLE_NAME}
          description="Edit the team, its members and LLM limits"
        >
          Admin
        </SelectItem>
        <SelectItem
          value={MEMBER_ROLE_NAME}
          description="Use resources shared with the team"
        >
          Member
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
