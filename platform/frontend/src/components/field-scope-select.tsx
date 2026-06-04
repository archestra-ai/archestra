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

export type FieldScopeValue = "installation" | "static";

interface FieldScopeSelectProps {
  value: FieldScopeValue;
  onChange: (next: FieldScopeValue) => void;
  /** When true, "installation" is forbidden (e.g. multi-tenant servers). */
  disableInstallation?: boolean;
  /** Tooltip copy shown when the disabled "Installation" option is hovered. */
  disabledReason?: string;
}

export function FieldScopeSelect({
  value,
  onChange,
  disableInstallation = false,
  disabledReason,
}: FieldScopeSelectProps) {
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
        <SelectItem value="static">Static</SelectItem>
      </SelectContent>
    </Select>
  );
}
