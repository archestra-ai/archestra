"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface MultiSelectProps {
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  items: Array<{ value: string; label: string }>;
  className?: string;
  disabled?: boolean;
  showSelectedBadges?: boolean;
  triggerTestId?: string;
}

export function MultiSelect({
  value,
  onValueChange,
  placeholder = "Select items...",
  items,
  className,
  disabled = false,
  showSelectedBadges = true,
  triggerTestId,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const filteredItems = React.useMemo(() => {
    if (!searchQuery) return items;

    const query = searchQuery.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(query));
  }, [items, searchQuery]);

  const selectedItems = items.filter((item) => value.includes(item.value));

  const handleToggleItem = (itemValue: string) => {
    if (value.includes(itemValue)) {
      onValueChange(value.filter((v) => v !== itemValue));
    } else {
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
          <div className="flex flex-wrap gap-1 flex-1">
            {selectedItems.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : showSelectedBadges ? (
              selectedItems.map((item) => (
                <Badge
                  key={item.value}
                  variant="secondary"
                  className="mr-1 mb-1"
                >
                  {item.label}
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
              ))
            ) : (
              <span data-testid={triggerTestId}>
                {selectedItems.length} selected
              </span>
            )}
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <div className="flex items-center border-b px-3 pb-2 pt-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1">
          {filteredItems.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          ) : (
            filteredItems.map((item) => {
              const isSelected = value.includes(item.value);
              return (
                <button
                  type="button"
                  key={item.value}
                  onClick={() => handleToggleItem(item.value)}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent text-accent-foreground",
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
