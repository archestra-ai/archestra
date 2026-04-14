"use client";

import type { PopoverContentProps } from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  items: Array<{
    value: string;
    label: string;
    description?: string;
    searchText?: string;
    content?: React.ReactNode;
    selectedContent?: React.ReactNode;
    disabled?: boolean;
    checked?: boolean;
  }>;
  className?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  showSearchIcon?: boolean;
  hint?: string;
  onSearchQueryChange?: (value: string) => void;
  emptyMessage?: string;
  multiline?: boolean;
  contentClassName?: string;
  contentSide?: PopoverContentProps["side"];
  contentAlign?: PopoverContentProps["align"];
  contentAvoidCollisions?: PopoverContentProps["avoidCollisions"];
  listClassName?: string;
}

export function SearchableSelect({
  value,
  onValueChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  items,
  className,
  disabled = false,
  allowCustom = false,
  showSearchIcon = true,
  hint,
  onSearchQueryChange,
  emptyMessage = "No results found.",
  multiline = false,
  contentClassName,
  contentSide,
  contentAlign,
  contentAvoidCollisions,
  listClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const filteredItems = React.useMemo(() => {
    if (!searchQuery) return items;

    const query = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        (item.searchText ?? item.label).toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query),
    );
  }, [items, searchQuery]);

  const selectedItem = items.find((item) => item.value === value);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (allowCustom && e.key === "Enter" && searchQuery && open) {
      e.preventDefault();
      onValueChange(searchQuery);
      setOpen(false);
      setSearchQuery("");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            multiline
              ? "border-input h-auto min-h-9 w-[200px] justify-between bg-transparent py-2 font-normal shadow-xs hover:bg-transparent hover:text-foreground"
              : "border-input h-9 w-[200px] justify-between bg-transparent font-normal shadow-xs hover:bg-transparent hover:text-foreground",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedItem
              ? (selectedItem.selectedContent ??
                selectedItem.content ??
                selectedItem.label)
              : value || placeholder}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-hidden p-0",
          contentClassName,
        )}
        align={contentAlign ?? "start"}
        side={contentSide}
        avoidCollisions={contentAvoidCollisions}
      >
        <div className="flex items-center border-b px-3 py-2">
          {showSearchIcon && (
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          )}
          <input
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              onSearchQueryChange?.(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {hint && (
          <div className="mt-2 px-3 pb-1.5 text-xs text-muted-foreground">
            {hint}
          </div>
        )}
        <div
          className={cn(
            "max-h-[min(300px,calc(var(--radix-popover-content-available-height)-3rem))] overflow-y-auto p-1",
            listClassName,
          )}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {filteredItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {allowCustom && searchQuery ? (
                <>
                  Press{" "}
                  <kbd className="px-2 py-1 text-xs bg-muted rounded">
                    Enter
                  </kbd>{" "}
                  to use &quot;{searchQuery}&quot;
                </>
              ) : (
                emptyMessage
              )}
            </div>
          ) : (
            filteredItems.map((item) => (
              <button
                type="button"
                key={item.value}
                disabled={item.disabled}
                aria-disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) {
                    return;
                  }
                  onValueChange(item.value);
                  setOpen(false);
                  setSearchQuery("");
                }}
                className={cn(
                  "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                  value === item.value && "bg-accent/50",
                  item.disabled &&
                    "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-inherit",
                )}
              >
                <span className="min-w-0 flex-1">
                  {item.content ?? item.label}
                  {item.description && (
                    <span className="block text-xs text-muted-foreground truncate">
                      {item.description}
                    </span>
                  )}
                </span>
                <Check
                  className={cn(
                    "ml-2 h-4 w-4 shrink-0",
                    value === item.value || item.checked
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
