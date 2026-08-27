"use client";

import { ArrowDownUp, BellOff, Check, ChevronDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
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
import {
  MCP_SERVER_ISSUE_KINDS,
  type McpServerAttentionFacet,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";

export type SortKey =
  | "attention"
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest"
  | "most-tools"
  | "issue-age";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "attention", label: "Action required" },
  { key: "name-asc", label: "Name (A–Z)" },
  { key: "name-desc", label: "Name (Z–A)" },
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "most-tools", label: "Most tools" },
  // Answers "what has been broken the longest", which is the question a
  // re-authentication backlog is actually triaged by.
  { key: "issue-age", label: "Longest outstanding" },
];

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterGroup = "status" | "issue" | "environment" | "author";

/** Also the search-param names the groups are addressable through. */
export const FILTER_GROUPS: FilterGroup[] = [
  "status",
  "issue",
  "environment",
  "author",
];

export type RegistryFilters = Record<FilterGroup, Set<string>>;

export function emptyRegistryFilters(): RegistryFilters {
  return {
    status: new Set(),
    issue: new Set(),
    environment: new Set(),
    author: new Set(),
  };
}

/**
 * The search param the whole Status filter lives in, facets included. One
 * param means one addressable list: `?status=needs-my-action` is a URL that
 * can be linked to from the sidebar, bookmarked, and redirected to.
 */
export const REGISTRY_STATUS_PARAM = "status";

export const INSTALLED_STATUS_VALUE = "installed";
export const NOT_INSTALLED_STATUS_VALUE = "not-installed";

/**
 * The audience facets, as status values. They share the `status` param with
 * the installed/not-installed options but are mutually exclusive with each
 * other, because an item belongs to exactly one facet and a viewer asking
 * "what is mine" is asking one question, not building a set.
 */
export const ATTENTION_FACET_STATUS_VALUES = {
  you: "needs-my-action",
  others: "waiting-on-someone-else",
  muted: "muted",
} as const satisfies Record<McpServerAttentionFacet, string>;

const FACET_BY_STATUS_VALUE = new Map<string, McpServerAttentionFacet>(
  (
    Object.entries(ATTENTION_FACET_STATUS_VALUES) as [
      McpServerAttentionFacet,
      string,
    ][]
  ).map(([facet, value]) => [value, facet]),
);

/** The facet a `status` selection is narrowed to, or null for the whole list. */
export function selectedAttentionFacet(
  status: Set<string>,
): McpServerAttentionFacet | null {
  for (const value of status) {
    const facet = FACET_BY_STATUS_VALUE.get(value);
    if (facet) return facet;
  }
  return null;
}

/**
 * `status` with exactly one facet selected, or none. The facets replace each
 * other rather than accumulating: an item belongs to exactly one of them, so a
 * selection of two would always be a selection of everything.
 */
export function withAttentionFacet(
  status: Set<string>,
  facet: McpServerAttentionFacet | null,
): Set<string> {
  const next = new Set(
    [...status].filter((value) => !FACET_BY_STATUS_VALUE.has(value)),
  );
  if (facet) next.add(ATTENTION_FACET_STATUS_VALUES[facet]);
  return next;
}

export const STATUS_OPTIONS: FilterOption[] = [
  { value: INSTALLED_STATUS_VALUE, label: "Installed" },
  { value: NOT_INSTALLED_STATUS_VALUE, label: "Not installed" },
];
export const ISSUE_OPTIONS: FilterOption[] = MCP_SERVER_ISSUE_KINDS.map(
  ({ kind, label }) => ({ value: kind, label }),
);

const GROUP_LABELS: Record<FilterGroup, string> = {
  status: "Status",
  issue: "Issue",
  environment: "Environment",
  author: "Author",
};

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.label]),
);
const ISSUE_LABELS: Record<string, string> = Object.fromEntries(
  ISSUE_OPTIONS.map((o) => [o.value, o.label]),
);

// Facet values are view state rather than filter chips. They are listed here
// only so a hand-edited URL carrying one cannot produce a raw-slug chip.
const FACET_VALUES = new Set<string>(
  Object.values(ATTENTION_FACET_STATUS_VALUES),
);

// Lists longer than this get an inline search box.
const SEARCH_THRESHOLD = 6;

export function RegistrySortMenu({
  value,
  onChange,
  options = SORT_OPTIONS,
}: {
  value: SortKey;
  onChange: (key: SortKey) => void;
  options?: { key: SortKey; label: string }[];
}) {
  const current = options.find((o) => o.key === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={filterControlClass()}>
          <ArrowDownUp className="h-4 w-4" />
          {/* Inherits the button's foreground: muted-foreground dips below the
              4.5:1 contrast minimum on some themes (WCAG 1.4.3). */}
          <span>Sort:</span>
          {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {options.map((o) => (
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

/**
 * Dismissed alerts, as a filter on the list rather than a tab of its own.
 *
 * They used to be a third tab beside "Action required", which put a view
 * almost nobody opens on the same footing as the one everybody works in and
 * made the tab strip grow and shrink with the dismissal count. It is the same
 * question — "what needs me?" — asked with the silenced ones instead of
 * without them, so it belongs next to the list's other filters.
 */
export function RegistryDismissedFilter({
  count,
  pressed,
  onToggle,
}: {
  count: number;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={pressed}
      className={filterControlClass({ active: pressed })}
      onClick={onToggle}
    >
      <BellOff aria-hidden className="h-4 w-4" />
      <span>Dismissed</span>
      {/* Inherits the button's foreground: muted-foreground dips below the
          4.5:1 contrast minimum on some themes (WCAG 1.4.3). */}
      <span className="tabular-nums">({count})</span>
    </Button>
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
  // Only what this dropdown actually offers. Attention facets are carried in
  // the same `status` param, but this control does not offer them, so counting
  // the raw selection would claim a filter the list below does not contain.
  const offered = new Set(options.map((o) => o.value));
  const count = [...selected].filter((v) => offered.has(v)).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={filterControlClass({ active: count > 0 })}
        >
          {label}
          {count > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
              {count}
              <span className="sr-only">
                {count === 1 ? "filter applied" : "filters applied"}
              </span>
            </span>
          )}
          <ChevronDown aria-hidden className="h-4 w-4 text-muted-foreground" />
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
  className,
  selected,
  onRemove,
  onClearAll,
}: {
  className?: string;
  selected: RegistryFilters;
  onRemove: (group: FilterGroup, value: string) => void;
  onClearAll: () => void;
}) {
  const entries: { group: FilterGroup; value: string; label: string }[] = [];
  (Object.keys(selected) as FilterGroup[]).forEach((group) => {
    selected[group].forEach((value) => {
      // Attention facets are view state, not applied filters; a second
      // dismissible copy of one would be two controls for one piece of state.
      if (group === "status" && FACET_VALUES.has(value)) return;
      entries.push({
        group,
        value,
        label:
          group === "status"
            ? (STATUS_LABELS[value] ?? value)
            : group === "issue"
              ? (ISSUE_LABELS[value] ?? value)
              : value,
      });
    });
  });
  if (entries.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {entries.map((entry) => (
        <Badge
          key={`${entry.group}-${entry.value}`}
          variant="secondary"
          className="gap-1.5 py-1 font-normal"
        >
          {/* The chip's prefix and dismiss icon inherit secondary-foreground —
              muted-foreground on the secondary fill falls below the 4.5:1
              contrast minimum on some themes (WCAG 1.4.3). */}
          <span>{GROUP_LABELS[entry.group]}:</span>
          {entry.label}
          <button
            type="button"
            aria-label={`Remove ${entry.label} filter`}
            onClick={() => onRemove(entry.group, entry.value)}
            className="ml-0.5 rounded-full p-0.5 hover:bg-background/60"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-sm text-foreground underline-offset-2 hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}
