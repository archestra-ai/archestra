"use client";

import {
  getAssignmentComboboxDisabledOptionTestId,
  getAssignmentComboboxOptionTestId,
  getAssignmentComboboxSearchInputTestId,
} from "@shared";
import { ExternalLink, Plus } from "lucide-react";
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
  placeholder?: string;
  emptyMessage?: string;
  createAction?: { label: string; href: string };
  className?: string;
  label?: string;
  testId?: string;
}

export function AssignmentCombobox({
  items,
  selectedIds,
  onToggle,
  onItemAdded,
  placeholder = "Search...",
  emptyMessage = "No items found.",
  createAction,
  className,
  label = "Add",
  testId,
}: AssignmentComboboxProps) {
  const [search, setSearch] = React.useState("");

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
    <DropdownMenu onOpenChange={() => setSearch("")}>
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
        className="w-96 max-h-72 flex flex-col"
        align="start"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-2 py-1.5">
          <Input
            placeholder={placeholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => e.stopPropagation()}
            data-testid={
              testId
                ? getAssignmentComboboxSearchInputTestId(testId)
                : undefined
            }
          />
        </div>
        <div className="overflow-y-auto flex-1">
          <DropdownMenuGroup>
            {filteredItems.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </div>
            ) : (
              filteredItems.map((item) => {
                const isSelected = selectedSet.has(item.id);
                if (item.disabled) {
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      disabled
                      className="cursor-pointer opacity-50"
                      data-testid={
                        testId
                          ? getAssignmentComboboxDisabledOptionTestId(
                              testId,
                              item.name,
                            )
                          : undefined
                      }
                    >
                      <div className="flex items-center gap-3 min-w-0 pl-6">
                        {item.icon}
                        <div className="min-w-0">
                          <span className="truncate">{item.name}</span>
                          {item.disabledReason && (
                            <p className="text-xs text-muted-foreground">
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
                    className="cursor-pointer"
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
                    <div className="flex items-center justify-between gap-2 w-full">
                      <div className="flex items-center gap-3 min-w-0">
                        {item.icon}
                        <div className="min-w-0">
                          <span className="truncate">{item.name}</span>
                          {item.description && (
                            <ItemDescription description={item.description} />
                          )}
                        </div>
                      </div>
                      {item.badge && (
                        <span className="text-xs text-muted-foreground shrink-0">
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
    <div className="text-xs text-muted-foreground mt-0.5">
      <p ref={ref} className={cn(!expanded && "line-clamp-1")}>
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
