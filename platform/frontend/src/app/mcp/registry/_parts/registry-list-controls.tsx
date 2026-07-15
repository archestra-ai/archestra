"use client";

import { ArrowDownUp, Check, ChevronDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SortKey =
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest"
  | "most-tools";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name-asc", label: "Name (A–Z)" },
  { key: "name-desc", label: "Name (Z–A)" },
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "most-tools", label: "Most tools" },
];

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterGroup = "status" | "environment" | "author";

export type RegistryFilters = Record<FilterGroup, Set<string>>;

export function emptyRegistryFilters(): RegistryFilters {
  return { status: new Set(), environment: new Set(), author: new Set() };
}

export const STATUS_OPTIONS: FilterOption[] = [
  { value: "installed", label: "Installed" },
  { value: "not-installed", label: "Not installed" },
];

const GROUP_LABELS: Record<FilterGroup, string> = {
  status: "Status",
  environment: "Environment",
  author: "Author",
};

const STATUS_LABELS: Record<string, string> = {
  installed: "Installed",
  "not-installed": "Not installed",
};

// Lists longer than this get an inline search box.
const SEARCH_THRESHOLD = 6;

export function RegistrySortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (key: SortKey) => void;
}) {
  const current = SORT_OPTIONS.find((o) => o.key === value) ?? SORT_OPTIONS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2 font-normal">
          <ArrowDownUp className="h-4 w-4" />
          <span className="text-muted-foreground">Sort:</span>
          {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {SORT_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.key} onClick={() => onChange(o.key)}>
            <Check
              className={cn(
                "h-4 w-4",
                o.key === value ? "opacity-100" : "opacity-0",
              )}
            />
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RegistryFilterDropdown({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  const count = selected.size;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-1.5 font-normal">
          {label}
          {count > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
              {count}
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <FilterOptionList
          options={options}
          selected={selected}
          onToggle={onToggle}
          searchLabel={label.toLowerCase()}
        />
      </PopoverContent>
    </Popover>
  );
}

function FilterOptionList({
  options,
  selected,
  onToggle,
  searchLabel,
}: {
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  searchLabel: string;
}) {
  const [query, setQuery] = useState("");
  const showSearch = options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <>
      {showSearch && (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${searchLabel}`}
          aria-label={`Search ${searchLabel}`}
          className="mb-1.5 h-8"
        />
      )}
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-1.5 py-1.5 text-sm text-muted-foreground">
            No matches
          </div>
        ) : (
          visible.map((o) => {
            const id = `filter-${searchLabel}-${o.value}`.replace(
              /[^a-zA-Z0-9-]/g,
              "-",
            );
            return (
              <label
                key={o.value}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  id={id}
                  checked={selected.has(o.value)}
                  onCheckedChange={() => onToggle(o.value)}
                />
                <span className="truncate">{o.label}</span>
              </label>
            );
          })
        )}
      </div>
    </>
  );
}

export function RegistryFilterChips({
  selected,
  onRemove,
  onClearAll,
}: {
  selected: RegistryFilters;
  onRemove: (group: FilterGroup, value: string) => void;
  onClearAll: () => void;
}) {
  const entries: { group: FilterGroup; value: string; label: string }[] = [];
  (Object.keys(selected) as FilterGroup[]).forEach((group) => {
    selected[group].forEach((value) => {
      entries.push({
        group,
        value,
        label: group === "status" ? (STATUS_LABELS[value] ?? value) : value,
      });
    });
  });
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => (
        <Badge
          key={`${entry.group}-${entry.value}`}
          variant="secondary"
          className="gap-1.5 py-1 font-normal"
        >
          <span className="text-muted-foreground">
            {GROUP_LABELS[entry.group]}:
          </span>
          {entry.label}
          <button
            type="button"
            aria-label={`Remove ${entry.label} filter`}
            onClick={() => onRemove(entry.group, entry.value)}
            className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        Clear all
      </button>
    </div>
  );
}
