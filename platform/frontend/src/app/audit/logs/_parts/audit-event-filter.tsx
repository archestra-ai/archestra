"use client";

import { ArrowLeft, ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
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
import { matchesSearchTokens } from "@/lib/search-tokens";
import { cn } from "@/lib/utils/tailwind";
import {
  AUDIT_EVENT_ENTRIES,
  type AuditEventEntry,
  auditResourceIcon,
  findAuditEventEntry,
} from "./audit-event-taxonomy";
import { formatAction } from "./audit-log-action-labels";
import {
  focusFirstPickerRow,
  movePickerFocus,
  PICKER_PANE_HEIGHT,
  PICKER_ROW_CLASS,
  PickerRow,
  PickerTile,
} from "./filter-picker-panes";

type EventFilterValue = {
  action: string | null;
  resourceType: string | null;
};

/**
 * One filter for "what happened": resource type and action are the same axis
 * (`agent.updated` is an Agent event), so the bar offers them together.
 * Browse area → type → verb in two panes, or type to search everything. An
 * action is stored alone; "Any <type> event" stores the type (an entry key).
 */
export function AuditEventFilter({
  action,
  resourceType,
  compact,
  onChange,
}: {
  action?: string;
  resourceType?: string;
  /** Phone/tablet layout: the two panes stack and drill in. */
  compact: boolean;
  onChange: (next: EventFilterValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const activeType = findAuditEventEntry({ action, resourceType })?.key ?? null;
  const [focusedType, setFocusedType] = useState<string>(
    initialFocus(activeType),
  );
  const [drilled, setDrilled] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const focusedEntry = ENTRY_BY_KEY.get(focusedType) ?? AUDIT_EVENT_ENTRIES[0];
  const trimmed = query.trim();
  const results = useMemo(() => searchEvents(trimmed), [trimmed]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setFocusedType(initialFocus(activeType));
      setDrilled(false);
    }
  };

  // Keep the browse list anchored on the current selection when it opens, and
  // move keyboard focus with the drill-in on compact screens.
  // Only on open and on drill changes; following every focus change would
  // fight the person's own scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (compact && drilled) {
        focusFirstPickerRow(root, "right");
        return;
      }
      const row = root.querySelector<HTMLElement>(
        `[data-nav="left"][data-type="${focusedType}"]`,
      );
      row?.scrollIntoView({ block: "center" });
      if (compact) row?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, drilled, compact]);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const commit = (next: EventFilterValue) => {
    onChange(next);
    setOpen(false);
  };

  const previewType = (type: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // A short hover intent so a diagonal move toward the right pane does not
    // swap it for every row the pointer crosses on the way.
    hoverTimer.current = setTimeout(() => setFocusedType(type), 110);
  };
  const cancelPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };

  const openType = (type: string, event: MouseEvent<HTMLButtonElement>) => {
    cancelPreview();
    setFocusedType(type);
    if (compact) {
      setDrilled(true);
      return;
    }
    // Enter/Space arrive as a click with no pointer detail: carry focus on.
    if (event.detail === 0) {
      requestAnimationFrame(() =>
        focusFirstPickerRow(rootRef.current, "right"),
      );
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (trimmed) focusFirstPickerRow(root, "result");
      else if (compact && drilled) focusFirstPickerRow(root, "right");
      else
        (
          root.querySelector<HTMLElement>(
            `[data-nav="left"][data-type="${focusedType}"]`,
          ) ?? root.querySelector<HTMLElement>('[data-nav="left"]')
        )?.focus();
    } else if (event.key === "Enter" && trimmed) {
      event.preventDefault();
      root.querySelector<HTMLElement>('[data-nav="result"]')?.click();
    }
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
            `[data-nav="left"][data-type="${focusedType}"]`,
          )
          ?.focus();
    }
  };

  const trigger = describeSelection({ action, resourceType });
  const TriggerIcon = trigger.type ? auditResourceIcon(trigger.type) : null;
  const paneHeight = PICKER_PANE_HEIGHT;

  const leftPane = (
    <div
      className={cn("overflow-y-auto overscroll-contain p-1", paneHeight)}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <PickerRow
        nav="left"
        selected={!action && !resourceType}
        onClick={() => commit({ action: null, resourceType: null })}
        className="font-medium"
      >
        All events
      </PickerRow>
      {AREA_SECTIONS.map(({ area, entries }) => {
        const AreaIcon = area.icon;
        return (
          <div key={area.key} className="mt-1">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              <AreaIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{area.label}</span>
            </div>
            {entries.map((entry) => {
              const isFocused = !compact && entry.key === focusedType;
              const isActive = entry.key === activeType;
              return (
                <UnstyledButton
                  key={entry.key}
                  data-nav="left"
                  data-type={entry.key}
                  aria-current={isFocused ? "true" : undefined}
                  onMouseEnter={
                    compact ? undefined : () => previewType(entry.key)
                  }
                  onMouseLeave={compact ? undefined : cancelPreview}
                  onFocus={
                    compact ? undefined : () => setFocusedType(entry.key)
                  }
                  onClick={(event) => openType(entry.key, event)}
                  className={cn(
                    PICKER_ROW_CLASS,
                    "pl-7.5",
                    isFocused && "bg-accent text-accent-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      isActive && "font-medium",
                    )}
                  >
                    {entry.label}
                  </span>
                  {isActive ? (
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                    />
                  ) : null}
                  {isActive ? (
                    <span className="sr-only">(filtered)</span>
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
      })}
    </div>
  );

  const rightPane = (
    <div className={cn("flex min-w-0 flex-col", paneHeight)}>
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
        <PickerTile type={focusedEntry.resourceTypes[0]} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-5 font-medium">
            {focusedEntry.label}
          </div>
          <div className="truncate text-xs leading-4 text-muted-foreground">
            {focusedEntry.area.label} · {focusedEntry.actions.length}{" "}
            {focusedEntry.actions.length === 1 ? "event" : "events"}
          </div>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <PickerRow
          nav="right"
          selected={!action && resourceType === focusedEntry.key}
          onClick={() =>
            commit({ action: null, resourceType: focusedEntry.key })
          }
          className="font-medium"
        >
          {anyLabel(focusedEntry.label)}
        </PickerRow>
        <div aria-hidden className="mx-2 my-1 h-px bg-border" />
        {focusedEntry.actions.map((item) => (
          <PickerRow
            key={item.value}
            nav="right"
            selected={action === item.value}
            hint={item.value}
            onClick={() => commit({ action: item.value, resourceType: null })}
          >
            {item.verbLabel}
          </PickerRow>
        ))}
      </div>
    </div>
  );

  const searchPane = (
    <div
      className={cn(
        "overflow-y-auto overscroll-contain p-1",
        "max-h-[min(22rem,calc(var(--radix-popover-content-available-height)-2.75rem))]",
      )}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {results.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No events match “{trimmed}”
        </div>
      ) : (
        results.map(({ entry, anyMatch, actions }) => {
          const Icon = auditResourceIcon(entry.resourceTypes[0]);
          return (
            <div key={entry.key} className="mb-1">
              <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs text-muted-foreground">
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate font-medium">{entry.label}</span>
                <span className="truncate text-muted-foreground/70">
                  {entry.area.label}
                </span>
              </div>
              {anyMatch ? (
                <PickerRow
                  nav="result"
                  selected={!action && resourceType === entry.key}
                  onClick={() =>
                    commit({ action: null, resourceType: entry.key })
                  }
                  className="pl-7.5"
                >
                  {anyLabel(entry.label)}
                </PickerRow>
              ) : null}
              {actions.map((item) => (
                <PickerRow
                  key={item.value}
                  nav="result"
                  selected={action === item.value}
                  hint={item.value}
                  onClick={() =>
                    commit({ action: item.value, resourceType: null })
                  }
                  className="pl-7.5"
                >
                  {item.verbLabel}
                </PickerRow>
              ))}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Event filter: ${trigger.text}`}
          className={filterControlClass({
            active: !!(action || resourceType),
            className: "justify-between",
          })}
        >
          {TriggerIcon ? (
            <TriggerIcon
              aria-hidden
              className="size-3.5 shrink-0 text-foreground/70"
            />
          ) : null}
          <span
            key={trigger.text}
            className="min-w-0 flex-1 truncate text-left"
          >
            <span>{trigger.primary}</span>
            {trigger.secondary ? (
              <span className="font-normal text-foreground/60">
                {" · "}
                {trigger.secondary}
              </span>
            ) : null}
          </span>
          <ChevronDown aria-hidden className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Filter by event"
        className={cn(
          "flex flex-col overflow-hidden p-0",
          compact
            ? "w-[min(22rem,calc(100vw-2rem))]"
            : "w-[min(36rem,calc(100vw-2rem))]",
        )}
        // Phones would raise the keyboard over the list on open.
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
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search events…"
              aria-label="Search events"
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

// ============================================================================
// Internal helpers
// ============================================================================

const ENTRY_BY_KEY = new Map(
  AUDIT_EVENT_ENTRIES.map((entry) => [entry.key, entry]),
);

const AREA_SECTIONS = AUDIT_EVENT_ENTRIES.reduce<
  { area: AuditEventEntry["area"]; entries: AuditEventEntry[] }[]
>((sections, entry) => {
  const last = sections.at(-1);
  if (last?.area.key === entry.area.key) last.entries.push(entry);
  else sections.push({ area: entry.area, entries: [entry] });
  return sections;
}, []);

function describeSelection({
  action,
  resourceType,
}: {
  action?: string;
  resourceType?: string;
}): { text: string; primary: string; secondary?: string; type?: string } {
  const entry = findAuditEventEntry({ action, resourceType });
  if (action) {
    const text = formatAction(action);
    return { text, primary: text, type: entry?.resourceTypes[0] };
  }
  if (resourceType) {
    const label = entry?.label ?? resourceType;
    return {
      text: `${label}, any event`,
      primary: label,
      secondary: "any",
      type: entry?.resourceTypes[0],
    };
  }
  return { text: "All events", primary: "All events" };
}

function initialFocus(activeType: string | null): string {
  return activeType && ENTRY_BY_KEY.has(activeType)
    ? activeType
    : (AUDIT_EVENT_ENTRIES[0]?.key ?? "");
}

function searchEvents(query: string) {
  if (!query) return [];
  return AUDIT_EVENT_ENTRIES.flatMap((entry) => {
    const anyMatch = matchesSearchTokens(query, [
      entry.label,
      ...entry.resourceTypes,
      entry.area.label,
    ]);
    const actions = entry.actions.filter((item) =>
      matchesSearchTokens(query, [
        item.label,
        item.value,
        entry.label,
        entry.area.label,
      ]),
    );
    if (!anyMatch && actions.length === 0) return [];
    return [{ entry, anyMatch, actions }];
  });
}

/** "Any agent event", keeping acronyms such as "MCP server" intact. */
function anyLabel(typeLabel: string): string {
  const keepCase = /^[A-Z]{2}/.test(typeLabel);
  const name = keepCase
    ? typeLabel
    : typeLabel.charAt(0).toLowerCase() + typeLabel.slice(1);
  return `Any ${name} event`;
}
