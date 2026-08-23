"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { OsLogos } from "./os-logos";
import {
  CONNECT_PLATFORM_OPTIONS,
  type ConnectPlatformOption,
  platformLabels,
} from "./platform.utils";

/** The canonical OS selector shared by connection setup and Plugin import. */
export function ConnectionPlatformSelect({
  value,
  onValueChange,
  options = CONNECT_PLATFORM_OPTIONS,
  id,
  ariaLabel = "Select a platform",
  dataTestId,
  className,
  disabled,
}: {
  value: ConnectPlatformOption;
  onValueChange: (value: ConnectPlatformOption) => void;
  options?: readonly ConnectPlatformOption[];
  id?: string;
  ariaLabel?: string;
  dataTestId?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as ConnectPlatformOption)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn("w-full", className)}
        data-testid={dataTestId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((platform) => (
          <SelectItem key={platform} value={platform}>
            <span className="flex items-center gap-2">
              <OsLogos platform={platform} />
              {platformLabels[platform]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Connection-styled multi-select for flows that can target multiple OSes. */
export function ConnectionPlatformMultiSelect({
  value,
  onValueChange,
  options = CONNECT_PLATFORM_OPTIONS,
  id,
  ariaLabel = "Select platforms",
  className,
  disabled,
}: {
  value: ConnectPlatformOption[];
  onValueChange: (value: ConnectPlatformOption[]) => void;
  options?: readonly ConnectPlatformOption[];
  id?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const selected = options.filter((platform) => value.includes(platform));
  const allSelected = options.length > 1 && selected.length === options.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          className={cn(
            "h-9 w-full justify-between px-3 font-normal",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected.map((platform) => (
              <OsLogos key={platform} platform={platform} />
            ))}
            <span className="truncate">
              {allSelected
                ? "All platforms"
                : selected.length === 1
                  ? platformLabels[selected[0] as ConnectPlatformOption]
                  : "Select platforms"}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        {options.map((platform) => {
          const checked = value.includes(platform);
          return (
            <DropdownMenuCheckboxItem
              key={platform}
              checked={checked}
              disabled={checked && selected.length === 1}
              onCheckedChange={(nextChecked) => {
                if (nextChecked) {
                  onValueChange([...selected, platform]);
                } else if (selected.length > 1) {
                  onValueChange(selected.filter((item) => item !== platform));
                }
              }}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex items-center gap-2">
                <OsLogos platform={platform} />
                {platformLabels[platform]}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
