"use client";

import {
  ArrowLeft,
  Blocks,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { filterControlClass } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAuditLogResourceSearch } from "@/lib/audit-log/audit-log.query";
import { cn } from "@/lib/utils/tailwind";
import { auditResourceIcon } from "./audit-event-taxonomy";
import { formatResourceType } from "./audit-log-action-labels";
import {
  focusFirstPickerRow,
  movePickerFocus,
  PICKER_PANE_HEIGHT,
  PICKER_ROW_CLASS,
  PickerRow,
  PickerTile,
} from "./filter-picker-panes";

/**
 * One named object (an agent, an MCP server…), in two panes like the event
 * filter: its type on the left, that type's names on the right; search looks
 * across every type. `resourceTypes` narrows the types to the event filter's
 * pick, so "Agent updated" offers agents only.
 */
export function AuditResourceFilter({
  resourceId,
  resourceTypes,
  compact,
  onChange,
}: {
  resourceId?: string;
  resourceTypes?: string[];
  /** Phone/tablet layout: the panes stack and drill in. */
  compact: boolean;
  onChange: (resourceId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drilled, setDrilled] = useState(false);
  const types = useMemo(
    () =>
      resourceTypes
        ? PICKABLE_TYPES.filter((type) => resourceTypes.includes(type))
        : PICKABLE_TYPES,
    [resourceTypes],
  );
  const [focusedType, setFocusedType] = useState<string | undefined>(types[0]);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = query.trim();
  const shownType =
    focusedType && types.includes(focusedType) ? focusedType : types[0];
  // One query serves both views: the focused type's names, or a search across
  // every offered type.
  const search = useAuditLogResourceSearch({
    enabled: open && types.length > 0,
    selectedResourceId: resourceId,
    resourceType: trimmed ? types.join(",") : shownType,
  });
  const selected = search.selected;

  const groups = useMemo(() => {
    const byType = new Map<string, typeof search.options>();
    for (const option of search.options) {
      const list = byType.get(option.resourceType) ?? [];
      list.push(option);
      byType.set(option.resourceType, list);
    }
    return [...byType.entries()]
      .map(([type, options]) => ({
        type,
        label: formatResourceType(type),
        options,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [search.options]);

  const setSearch = (value: string) => {
    setQuery(value);
    search.onSearchQueryChange(value);
  };
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFocusedType(
        selected && types.includes(selected.resourceType)
          ? selected.resourceType
          : types[0],
      );
      setDrilled(false);
    } else {
      setSearch("");
    }
  };
  const commit = (value: string | null) => {
    onChange(value);
    handleOpenChange(false);
  };

  useEffect(() => {
    if (!open || !compact) return;
    const frame = requestAnimationFrame(() =>
      focusFirstPickerRow(rootRef.current, drilled ? "right" : "left"),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, drilled, compact]);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const previewType = (type: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // Hover intent, so a diagonal move to the right pane keeps it.
    hoverTimer.current = setTimeout(() => setFocusedType(type), 110);
  };
  const cancelPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };

  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const group = target.dataset.nav;
    if (!group) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const moved = movePickerFocus({
        root: rootRef.current,
        group,
        from: target,
        delta: event.key === "ArrowDown" ? 1 : -1,
      });
      if (!moved && event.key === "ArrowUp") inputRef.current?.focus();
    } else if (event.key === "ArrowRight" && group === "left") {
      const type = target.dataset.type;
      if (!type) return;
      event.preventDefault();
      setFocusedType(type);
      if (compact) setDrilled(true);
      else focusFirstPickerRow(rootRef.current, "right");
    } else if (event.key === "ArrowLeft" && group === "right") {
      event.preventDefault();
      if (compact) setDrilled(false);
      else
        rootRef.current
          ?.querySelector<HTMLElement>(
            `[data-nav="left"][data-type="${shownType}"]`,
          )
          ?.focus();
    }
  };

  const optionRows = (options: typeof search.options, nav: string) =>
    options.map((option) => {
      const Icon = auditResourceIcon(option.resourceType);
      return (
        <PickerRow
          key={`${option.resourceType}:${option.resourceId}`}
          nav={nav}
          selected={option.resourceId === resourceId}
          leading={
            <Icon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          }
          description={option.detail}
          onClick={() => commit(option.resourceId)}
        >
          <span title={option.name}>{option.name}</span>
        </PickerRow>
      );
    });

  const status = search.isSearching ? (
    <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      <span>Loading…</span>
    </div>
  ) : null;
  const truncatedNote = search.isTruncated ? (
    <p className="px-2 py-2 text-xs text-muted-foreground">
      Showing the first {search.options.length}. Search to find more.
    </p>
  ) : null;

  const leftPane = (
    <div
      className={cn(
        "overflow-y-auto overscroll-contain p-1",
        PICKER_PANE_HEIGHT,
      )}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <PickerRow
        nav="left"
        selected={!resourceId}
        leading={<TypeIcon type={null} />}
        onClick={() => commit(null)}
        className="font-medium"
      >
        All resources
      </PickerRow>
      {types.length > 0 ? (
        <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
          Type
        </div>
      ) : (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          The picked event has no named resources to narrow to.
        </p>
      )}
      {types.map((type) => {
        const isFocused = !compact && type === shownType;
        const isActive = !!resourceId && selected?.resourceType === type;
        return (
          <UnstyledButton
            key={type}
            data-nav="left"
            data-type={type}
            aria-current={isFocused ? "true" : undefined}
            onMouseEnter={compact ? undefined : () => previewType(type)}
            onMouseLeave={compact ? undefined : cancelPreview}
            onFocus={compact ? undefined : () => setFocusedType(type)}
            onClick={() => {
              cancelPreview();
              setFocusedType(type);
              if (compact) setDrilled(true);
            }}
            className={cn(
              PICKER_ROW_CLASS,
              isFocused && "bg-accent text-accent-foreground",
            )}
          >
            <TypeIcon type={type} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isActive && "font-medium",
              )}
            >
              {pluralType(type)}
            </span>
            {isActive ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground",
                !compact && !isFocused && "opacity-0",
              )}
            />
          </UnstyledButton>
        );
      })}
    </div>
  );

  const rightPane = shownType ? (
    <div className={cn("flex min-w-0 flex-col", PICKER_PANE_HEIGHT)}>
      <div className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2">
        {compact ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Back to all types"
            className="-ml-1.5"
            onClick={() => setDrilled(false)}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <PickerTile type={shownType} />
        <div className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
          {pluralType(shownType)}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        {search.options.length > 0
          ? optionRows(search.options, "right")
          : (status ?? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No {pluralType(shownType).toLowerCase()} in the trail yet.
              </div>
            ))}
        {truncatedNote}
      </div>
    </div>
  ) : null;

  const searchPane = (
    <div
      className="max-h-[min(22rem,calc(var(--radix-popover-content-available-height)-2.75rem))] overflow-y-auto overscroll-contain p-1"
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {groups.map((group) => (
        <SearchGroup key={group.type} heading={pluralType(group.type)}>
          {optionRows(group.options, "result")}
        </SearchGroup>
      ))}
      {groups.length === 0 &&
        (status ?? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No resources match “{trimmed}”
          </div>
        ))}
      {truncatedNote}
    </div>
  );

  const SelectedIcon = resourceId
    ? auditResourceIcon(selected?.resourceType)
    : null;
  const triggerLabel = resourceId
    ? (selected?.name ?? "Selected resource")
    : "All resources";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Resource filter: ${triggerLabel}`}
          className={filterControlClass({ active: !!resourceId })}
        >
          {SelectedIcon ? (
            <SelectedIcon aria-hidden className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">
            {triggerLabel}
          </span>
          <ChevronDown aria-hidden className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Filter by resource"
        className={cn(
          "flex flex-col overflow-hidden p-0",
          compact
            ? "w-[min(22rem,calc(100vw-2rem))]"
            : "w-[min(36rem,calc(100vw-2rem))]",
        )}
        onOpenAutoFocus={(event) => {
          if (compact) event.preventDefault();
        }}
        onKeyDown={onNavKeyDown}
      >
        <div ref={rootRef} className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-3">
            <Search
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusFirstPickerRow(
                    rootRef.current,
                    trimmed ? "result" : compact && drilled ? "right" : "left",
                  );
                }
              }}
              placeholder="Search by name…"
              aria-label="Search resources"
              disabled={types.length === 0}
              className="h-10 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {trimmed ? (
            searchPane
          ) : compact ? (
            drilled ? (
              rightPane
            ) : (
              leftPane
            )
          ) : (
            <div className="grid grid-cols-[13.5rem_minmax(0,1fr)]">
              <div className="border-r">{leftPane}</div>
              {rightPane}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// === Internal helpers

/** The named types the resources endpoint lists (its `RESOURCE_FILTER_TYPES`). */
const PICKABLE_TYPES = [
  "agent",
  "app",
  "environment",
  "mcpServer",
  "role",
  "skill",
  "team",
];

function pluralType(type: string): string {
  return `${formatResourceType(type)}s`;
}

function TypeIcon({ type }: { type: string | null }) {
  const Icon = type ? auditResourceIcon(type) : Blocks;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function SearchGroup({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {heading}
      </div>
      {children}
    </div>
  );
}
