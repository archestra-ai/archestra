"use client";

import {
  getAssignmentComboboxDisabledOptionTestId,
  getAssignmentComboboxOptionTestId,
  getAssignmentComboboxSearchInputTestId,
} from "@archestra/shared";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface AssignmentComboboxItem {
  id: string;
  name: string;
  description?: string;
  badge?: string;
  sortRank?: number;
  disabled?: boolean;
  disabledReason?: string;
  icon?: React.ReactNode;
}

interface AssignmentComboboxProps {
  items: AssignmentComboboxItem[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  /** Called when a previously-unselected item is toggled ON */
  onItemAdded?: (id: string) => void;
  /**
   * Notified of the current search query, including the reset to `""` when the
   * dropdown opens or closes.
   *
   * For callers whose `items` are one page of a larger set: the local filter
   * below only ever sees what was passed in, so without this a query matching
   * an unloaded item reads as "no results" rather than "not loaded". Widening
   * `items` in response is the caller's job; this does not replace the filter.
   */
  onSearchChange?: (query: string) => void;
  /**
   * Whether the caller is still widening `items` for the current query. Without
   * it the empty message appears for the debounce plus the round trip, so a
   * search for something real reads as "it does not exist" and the user stops
   * looking.
   */
  isSearching?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  createAction?: { label: string; href: string };
  className?: string;
  label?: string;
  testId?: string;
  defaultOpen?: boolean;
}

export function AssignmentCombobox({
  items,
  selectedIds,
  onToggle,
  onItemAdded,
  onSearchChange,
  isSearching = false,
  placeholder = "Search...",
  emptyMessage = "No items found.",
  createAction,
  className,
  label = "Add",
  testId,
  defaultOpen,
}: AssignmentComboboxProps) {
  const [search, setSearch] = React.useState("");

  const updateSearch = React.useCallback(
    (query: string) => {
      setSearch(query);
      onSearchChange?.(query);
    },
    [onSearchChange],
  );

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredItems = React.useMemo(() => {
    const query = search.toLowerCase();
    const filtered = query
      ? items.filter((item) => getSearchMatchScore(item, query) > 0)
      : items;

    // Sort: selected first, then enabled, then disabled, then best search hit,
    // then alphabetically.
    return [...filtered].sort((a, b) => {
      const aSelected = selectedSet.has(a.id) ? 0 : 1;
      const bSelected = selectedSet.has(b.id) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      const aDisabled = a.disabled ? 1 : 0;
      const bDisabled = b.disabled ? 1 : 0;
      if (aDisabled !== bDisabled) return aDisabled - bDisabled;
      const aScore = query ? getSearchMatchScore(a, query) : 0;
      const bScore = query ? getSearchMatchScore(b, query) : 0;
      if (aScore !== bScore) return bScore - aScore;
      const aRank = a.sortRank ?? 0;
      const bRank = b.sortRank ?? 0;
      if (aRank !== bRank) return bRank - aRank;
      return a.name.localeCompare(b.name);
    });
  }, [items, search, selectedSet]);

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      onOpenChange={() => updateSearch("")}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 px-3 gap-1.5 text-xs border-dashed text-muted-foreground",
            className,
          )}
          data-testid={testId}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="flex max-h-72 w-96 max-w-[calc(100vw-2rem)] min-w-0 flex-col"
        align="start"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-2 py-1.5">
          <Input
            aria-label={placeholder || "Search"}
            placeholder={placeholder}
            value={search}
            onChange={(e) => updateSearch(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => e.stopPropagation()}
            data-testid={
              testId
                ? getAssignmentComboboxSearchInputTestId(testId)
                : undefined
            }
          />
        </div>
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <DropdownMenuGroup className="min-w-0">
            {filteredItems.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-2 py-4 text-center text-sm text-muted-foreground">
                {isSearching ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Searching…</span>
                  </>
                ) : (
                  <span>{emptyMessage}</span>
                )}
              </div>
            ) : (
              filteredItems.map((item) => {
                const isSelected = selectedSet.has(item.id);
                if (item.disabled) {
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      disabled
                      className="min-w-0 cursor-pointer opacity-50"
                      data-testid={
                        testId
                          ? getAssignmentComboboxDisabledOptionTestId(
                              testId,
                              item.name,
                            )
                          : undefined
                      }
                    >
                      <div className="flex w-full min-w-0 items-center gap-3 pl-6">
                        {item.icon}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate">{item.name}</span>
                          {item.disabledReason && (
                            <p className="truncate text-xs text-muted-foreground">
                              {item.disabledReason}
                            </p>
                          )}
                        </div>
                      </div>
                    </DropdownMenuItem>
                  );
                }
                return (
                  <DropdownMenuCheckboxItem
                    key={item.id}
                    checked={isSelected}
                    className="min-w-0 cursor-pointer"
                    data-testid={
                      testId
                        ? getAssignmentComboboxOptionTestId(testId, item.name)
                        : undefined
                    }
                    onCheckedChange={() => {
                      onToggle(item.id);
                      if (!isSelected) onItemAdded?.(item.id);
                    }}
                    onSelect={(e) => {
                      // Keep dropdown open when deselecting; close when selecting a new item
                      if (isSelected) e.preventDefault();
                    }}
                  >
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {item.icon}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate">{item.name}</span>
                          {item.description && (
                            <ItemDescription description={item.description} />
                          )}
                        </div>
                      </div>
                      {item.badge && (
                        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                          {item.badge}
                        </span>
                      )}
                    </div>
                  </DropdownMenuCheckboxItem>
                );
              })
            )}
          </DropdownMenuGroup>
        </div>
        {createAction && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href={createAction.href}
                target="_blank"
                rel="noopener"
                className="flex items-center gap-2 cursor-pointer"
              >
                <span className="text-sm">{createAction.label}</span>
                <ExternalLink className="h-3 w-3 ml-auto" />
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getSearchMatchScore(item: AssignmentComboboxItem, query: string) {
  const name = item.name.toLowerCase();
  const description = item.description?.toLowerCase() ?? "";

  if (name === query) return 5;
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (description.startsWith(query)) return 2;
  if (description.includes(query)) return 1;
  return 0;
}

function ItemDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const ref = React.useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = React.useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check truncation when description changes
  React.useEffect(() => {
    const el = ref.current;
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, [description]);

  return (
    <div className="min-w-0 text-xs text-muted-foreground mt-0.5">
      <p
        ref={ref}
        className={cn("[overflow-wrap:anywhere]", !expanded && "line-clamp-1")}
      >
        {description}
      </p>
      {(isTruncated || expanded) && (
        <button
          type="button"
          className="text-primary hover:underline text-[11px]"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
