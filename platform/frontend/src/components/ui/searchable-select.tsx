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
import { matchesSearchTokens } from "@/lib/search-tokens";
import { cn } from "@/lib/utils";

interface SearchableSelectItem {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
  content?: React.ReactNode;
  selectedContent?: React.ReactNode;
  disabled?: boolean;
  checked?: boolean;
}

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Applied to the trigger, so a sibling `<Label htmlFor>` can point at it. */
  id?: string;
  /**
   * Accessible name for the trigger. `role="combobox"` takes its name from the
   * author rather than from the trigger's contents, so without this the control
   * announces as an unnamed combobox.
   */
  ariaLabel?: string;
  /** Applied to the trigger, so tests can reach the control by test id. */
  "data-testid"?: string;
  /**
   * Forwarded to the trigger. A form wrapper (`FormControl`) injects these to
   * point the control at its description and error text; dropping them leaves
   * the message on screen but unannounced.
   */
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  searchPlaceholder?: string;
  items: Array<SearchableSelectItem>;
  /**
   * Rendered above the search results and never filtered out — for standing
   * choices like "Unassigned" that must stay reachable while searching.
   */
  pinnedItems?: Array<SearchableSelectItem>;
  className?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  showSearchIcon?: boolean;
  /**
   * Set false where the options are a short fixed set — a filter over two or
   * three known values shows the reader everything already, so the search
   * field is the one thing in the popover with nothing to do.
   *
   * Deliberately the caller's call rather than a count: keying it off how many
   * options happen to exist would give a roster a search field in one
   * organization and not another, and the search-first pickers (users, models,
   * virtual keys) would lose theirs whenever the list happened to be short.
   */
  showSearch?: boolean;
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
  id,
  ariaLabel,
  "data-testid": testId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  searchPlaceholder = "Search...",
  items,
  pinnedItems,
  className,
  disabled = false,
  allowCustom = false,
  showSearchIcon = true,
  showSearch = true,
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

    return items.filter((item) =>
      matchesSearchTokens(searchQuery, [
        item.searchText ?? item.label,
        item.description,
      ]),
    );
  }, [items, searchQuery]);

  const selectedItem = [...(pinnedItems ?? []), ...items].find(
    (item) => item.value === value,
  );

  const renderOption = (item: SearchableSelectItem) => (
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
          value === item.value || item.checked ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );

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
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          data-testid={testId}
          disabled={disabled}
          className={cn(
            multiline
              ? "border-input h-auto min-h-9 w-[200px] justify-between bg-transparent py-2 font-normal shadow-xs hover:bg-transparent hover:text-foreground"
              : "border-input h-9 w-[200px] justify-between bg-transparent font-normal shadow-xs hover:bg-transparent hover:text-foreground",
            !value && "text-muted-foreground",
            className,
          )}
        >
          {/* Keyed by the selection so changing it swaps this whole element
              instead of reconciling its children in place. Selected content is
              typically an icon beside a bare label, and reconciling that pair
              inserts the new icon before the label's text node — which crashes
              React once Chrome page-translate has re-parented that text into a
              <font> wrapper (facebook/react#11538). */}
          <span
            key={selectedItem?.value ?? value ?? ""}
            className="min-w-0 flex-1 truncate text-left"
          >
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
        {showSearch && (
          <div className="flex items-center border-b px-3 py-2">
            {showSearchIcon && (
              <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            )}
            <input
              aria-label={searchPlaceholder || "Search options"}
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
        )}
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
          {(pinnedItems ?? []).map(renderOption)}
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
            filteredItems.map(renderOption)
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
