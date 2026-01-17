"use client";

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
  items: Array<{ value: string; label: string }>;
  className?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  showSearchIcon?: boolean;
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
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const filteredItems = React.useMemo(() => {
    if (!searchQuery) return items;

    const query = searchQuery.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(query));
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
            "w-[200px] justify-between font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">
            {selectedItem ? selectedItem.label : value || placeholder}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <div className="flex items-center border-b px-3 py-2">
          {showSearchIcon && (
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          )}
          <input
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1">
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
                "No results found."
              )}
            </div>
          ) : (
            filteredItems.map((item) => (
              <button
                type="button"
                key={item.value}
                onClick={() => {
                  onValueChange(item.value);
                  setOpen(false);
                  setSearchQuery("");
                }}
                className={cn(
                  "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                  value === item.value && "bg-accent text-accent-foreground",
                )}
              >
                <span className="truncate">{item.label}</span>
                <Check
                  className={cn(
                    "ml-2 h-4 w-4 shrink-0",
                    value === item.value ? "opacity-100" : "opacity-0",
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
