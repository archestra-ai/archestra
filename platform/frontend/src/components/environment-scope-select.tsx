"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Sentinel for the organization-wide ("all environments") option, since shadcn
// Select can't use an empty string value. A NULL environmentId on the backend.
export const GLOBAL_ENVIRONMENT_SCOPE = "__global__";

export const GLOBAL_ENVIRONMENT_SCOPE_LABEL = "All environments (default)";

type EnvironmentScopeOption = {
  id: string;
  name: string;
  description?: string | null;
};

type EnvironmentScopeSelectProps = {
  /** Selected value: an environment id or GLOBAL_ENVIRONMENT_SCOPE. */
  value: string;
  onValueChange: (value: string) => void;
  environments: EnvironmentScopeOption[];
  /**
   * Render an "All environments (default)" option (the org-wide default,
   * GLOBAL_ENVIRONMENT_SCOPE) at the top of the list.
   */
  includeGlobalOption?: boolean;
  /**
   * Values (environment ids and/or GLOBAL_ENVIRONMENT_SCOPE) that already have
   * a limit configured. They stay visible but are disabled, with `takenReason`
   * shown as the option description to explain why they can't be selected.
   */
  takenValues?: ReadonlySet<string>;
  takenReason?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export function EnvironmentScopeSelect({
  value,
  onValueChange,
  environments,
  includeGlobalOption = false,
  takenValues,
  takenReason = "Already has a limit",
  placeholder = "Select environment",
  disabled,
  className,
}: EnvironmentScopeSelectProps) {
  const isTaken = (optionValue: string) =>
    takenValues?.has(optionValue) ?? false;

  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {includeGlobalOption && (
          <SelectItem
            value={GLOBAL_ENVIRONMENT_SCOPE}
            disabled={isTaken(GLOBAL_ENVIRONMENT_SCOPE)}
            description={
              isTaken(GLOBAL_ENVIRONMENT_SCOPE)
                ? takenReason
                : "Applies to every environment unless overridden"
            }
          >
            {GLOBAL_ENVIRONMENT_SCOPE_LABEL}
          </SelectItem>
        )}
        {environments.map((environment) => (
          <SelectItem
            key={environment.id}
            value={environment.id}
            disabled={isTaken(environment.id)}
            description={
              isTaken(environment.id)
                ? takenReason
                : (environment.description ?? undefined)
            }
          >
            {environment.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
