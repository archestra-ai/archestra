"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";

/** Connection-styled multi-select for flows spanning multiple agent clients. */
export function ConnectionClientMultiSelect({
  value,
  onValueChange,
  options,
  id,
  ariaLabel = "Select clients",
  className,
  disabled,
}: {
  value: ConnectClient[];
  onValueChange: (value: ConnectClient[]) => void;
  options: readonly ConnectClient[];
  id?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const selected = options.filter((client) =>
    value.some((item) => item.id === client.id),
  );
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
            {selected.map((client) => (
              <span key={client.id} aria-hidden>
                <ClientIcon client={client} size={18} />
              </span>
            ))}
            <span className="truncate">
              {allSelected
                ? "All clients"
                : selected.length === 1
                  ? selected[0]?.label
                  : "Select clients"}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        {options.map((client) => {
          const checked = selected.some((item) => item.id === client.id);
          return (
            <DropdownMenuCheckboxItem
              key={client.id}
              checked={checked}
              disabled={checked && selected.length === 1}
              onCheckedChange={(nextChecked) => {
                if (nextChecked) {
                  onValueChange([...selected, client]);
                } else if (selected.length > 1) {
                  onValueChange(
                    selected.filter((item) => item.id !== client.id),
                  );
                }
              }}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>
                  <ClientIcon client={client} size={18} />
                </span>
                {client.label}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
