"use client";

import type { PopoverContentProps } from "@radix-ui/react-popover";
import { Check, ChevronDown, Search, X } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SearchableMultiSelectProps {
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  items: Array<{
    value: string;
    label: string;
    searchText?: string;
    content?: React.ReactNode;
    selectedContent?: React.ReactNode;
    description?: string;
    disabled?: boolean;
  }>;
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  showSearchIcon?: boolean;
  contentClassName?: string;
  contentSide?: PopoverContentProps["side"];
  contentAlign?: PopoverContentProps["align"];
  contentAvoidCollisions?: PopoverContentProps["avoidCollisions"];
  listClassName?: string;
  maxBadgeDisplay?: number;
  maxSelected?: number;
  showSelectedBadges?: boolean;
  selectedSuffix?: string | ((count: number) => string);
}

export function SearchableMultiSelect({
  value,
  onValueChange,
  placeholder = "Select items...",
  searchPlaceholder = "Search...",
  items,
  className,
  disabled = false,
  emptyMessage = "No results found.",
  showSearchIcon = true,
  contentClassName,
  contentSide,
  contentAlign,
  contentAvoidCollisions,
  listClassName,
  maxBadgeDisplay = 3,
  maxSelected,
  showSelectedBadges = true,
  selectedSuffix = "selected",
}: SearchableMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const filteredItems = React.useMemo(() => {
    if (!searchQuery) return items;

    const query = searchQuery.toLowerCase();
    return items.filter((item) =>
      (item.searchText ?? item.label).toLowerCase().includes(query),
    );
  }, [items, searchQuery]);

  const selectedItems = items.filter((item) => value.includes(item.value));

  const handleToggleItem = (itemValue: string) => {
    if (value.includes(itemValue)) {
      onValueChange(value.filter((v) => v !== itemValue));
    } else if (maxSelected === undefined || value.length < maxSelected) {
      onValueChange([...value, itemValue]);
    }
  };

  const handleRemoveItem = (
    itemValue: string,
    e: React.MouseEvent | React.KeyboardEvent,
  ) => {
    e.stopPropagation();
    onValueChange(value.filter((v) => v !== itemValue));
  };

  const visibleBadges = selectedItems.slice(0, maxBadgeDisplay);
  const hiddenCount = selectedItems.length - maxBadgeDisplay;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          aria-expanded={open}
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(!open);
            }
          }}
          className={cn(
            "flex w-full min-h-10 h-auto items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer",
            !value.length && "text-muted-foreground",
            disabled && "cursor-not-allowed opacity-50",
            className,
          )}
        >
          <div className="flex flex-wrap gap-1 flex-1 items-center">
            {selectedItems.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : showSelectedBadges ? (
              <>
                {visibleBadges.map((item) => (
                  <Badge
                    key={item.value}
                    variant="secondary"
                    className="mr-1 mb-1"
                  >
                    {item.selectedContent ?? item.label}
                    <button
                      type="button"
                      className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleRemoveItem(item.value, e);
                        }
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => handleRemoveItem(item.value, e)}
                    >
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </Badge>
                ))}
                {hiddenCount > 0 && (
                  <Badge variant="secondary" className="mr-1 mb-1">
                    +{hiddenCount} more
                  </Badge>
                )}
              </>
            ) : (
              <span>
                {selectedItems.length}{" "}
                {typeof selectedSuffix === "function"
                  ? selectedSuffix(selectedItems.length)
                  : selectedSuffix}
              </span>
            )}
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </div>
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
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div
          className={cn(
            "max-h-[min(300px,calc(var(--radix-popover-content-available-height)-3rem))] overflow-y-auto p-1",
            listClassName,
          )}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {filteredItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            filteredItems.map((item) => {
              const isSelected = value.includes(item.value);
              return (
                <button
                  type="button"
                  key={item.value}
                  disabled={item.disabled}
                  aria-disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    handleToggleItem(item.value);
                  }}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent text-accent-foreground",
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
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
