"use client";

import { E2eTestId } from "@shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePresetEntityName } from "@/lib/organization.query";

export type FieldScopeValue = "installation" | "preset" | "static";

interface FieldScopeSelectProps {
  value: FieldScopeValue;
  onChange: (next: FieldScopeValue) => void;
  /** When false, the "preset" option is hidden (caller doesn't model preset-scoped values). */
  allowPresetScope?: boolean;
  /** When true, "installation" is forbidden (e.g. multi-tenant servers). */
  disableInstallation?: boolean;
  /** Tooltip copy shown when the disabled "Installation" option is hovered. */
  disabledReason?: string;
}

export function FieldScopeSelect({
  value,
  onChange,
  allowPresetScope = true,
  disableInstallation = false,
  disabledReason,
}: FieldScopeSelectProps) {
  const { singular, configured } = usePresetEntityName();
  const showPresetScope = allowPresetScope && configured;
  const installationItem = (
    <SelectItem
      value="installation"
      disabled={disableInstallation}
      className={
        disableInstallation ? "data-[disabled]:pointer-events-auto" : undefined
      }
    >
      Installation
    </SelectItem>
  );
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as FieldScopeValue)}
    >
      <SelectTrigger
        className="h-10"
        data-testid={E2eTestId.PromptOnInstallationCheckbox}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {disableInstallation && disabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>{installationItem}</TooltipTrigger>
            <TooltipContent side="right">
              <p className="max-w-xs">{disabledReason}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          installationItem
        )}
        {showPresetScope && <SelectItem value="preset">{singular}</SelectItem>}
        <SelectItem value="static">Static</SelectItem>
      </SelectContent>
    </Select>
  );
}
