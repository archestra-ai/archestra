"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxPickerItem {
  value: string;
  label: string;
}

interface ComboboxPickerProps {
  items: ComboboxPickerItem[];
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  kind: string;
  disabled?: boolean;
}

export function ComboboxPicker({
  items,
  value,
  onValueChange,
  placeholder,
  kind,
  disabled = false,
}: ComboboxPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  const selectedItems = useMemo(
    () =>
      value
        .map((id) => items.find((item) => item.value === id))
        .filter((item): item is ComboboxPickerItem => Boolean(item)),
    [items, value],
  );

  const toggle = (id: string) => {
    onValueChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  };

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          className={cn(
            "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-left text-sm transition-[box-shadow,border-color] outline-none",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            open && "border-ring ring-ring/50 ring-[3px]",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {selectedItems.length === 0 ? (
            <span className="flex-1 px-1 text-muted-foreground">
              {placeholder ?? `Select ${kind}s…`}
            </span>
          ) : (
            selectedItems.map((item) => (
              <span
                key={item.value}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-xs font-medium text-accent-foreground"
              >
                <span className="truncate">{item.label}</span>
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center rounded-full opacity-60 hover:opacity-100"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (disabled) return;
                    toggle(item.value);
                  }}
                >
                  <X className="size-3" />
                </span>
              </span>
            ))
          )}
          <span className="ml-auto flex items-center gap-1.5 pr-1 text-muted-foreground">
            <span className="font-mono text-[11px]">
              {selectedItems.length}/{items.length}
            </span>
            <ChevronDown className="size-3.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <div className="border-b p-2">
          <div className="flex h-8 items-center gap-2 rounded-md border bg-muted/40 px-2">
            <Search
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the search input when the popover opens
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${kind}s…`}
              className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span className="font-mono">
            {value.length} of {items.length} selected
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => onValueChange(items.map((item) => item.value))}
              disabled={value.length === items.length}
            >
              Select all
            </Button>
            <span className="text-border">·</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => onValueChange([])}
              disabled={value.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-5 text-center text-sm text-muted-foreground">
              No matches for "{query}"
            </div>
          ) : (
            filtered.map((item) => {
              const on = value.includes(item.value);
              return (
                <button
                  type="button"
                  key={item.value}
                  onClick={() => toggle(item.value)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
