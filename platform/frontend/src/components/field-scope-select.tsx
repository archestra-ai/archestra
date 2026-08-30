"use client";

import { E2eTestId } from "@archestra/shared";
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
  id?: string;
  value: FieldScopeValue;
  onChange: (next: FieldScopeValue) => void;
  disabled?: boolean;
  /** When true, "installation" is forbidden (e.g. multi-tenant servers). */
  disableInstallation?: boolean;
  /** Tooltip copy shown when the disabled "Installation" option is hovered. */
  disabledReason?: string;
  installationLabel?: string;
  staticLabel?: string;
}

export function FieldScopeSelect({
  id,
  value,
  onChange,
  disabled = false,
  disableInstallation = false,
  disabledReason,
  installationLabel = "Installation",
  staticLabel = "Static",
}: FieldScopeSelectProps) {
  const installationItem = (
    <SelectItem
      value="installation"
      disabled={disableInstallation}
      className={
        disableInstallation ? "data-[disabled]:pointer-events-auto" : undefined
      }
    >
      {installationLabel}
    </SelectItem>
  );
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as FieldScopeValue)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className="h-10 w-full"
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
        <SelectItem value="static">{staticLabel}</SelectItem>
      </SelectContent>
    </Select>
  );
}
