"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
  Search,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  focusFirstPickerRow,
  movePickerFocus,
  PICKER_ROW_CLASS,
  PickerTile,
} from "@/app/audit/logs/_parts/filter-picker-panes";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
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
  type ChipOption,
  ChipShell,
  ClearGlyph,
  Count,
  MENU_WIDTH,
  OptionItem,
} from "./filter-chip";

export type PaneItem = {
  value: string;
  label: string;
  count: number;
  leading?: ReactNode;
};

export type PaneGroup = {
  value: string;
  label: string;
  /** "Any agent event", the right pane's first row. */
  anyLabel: string;
  count: number;
  icon: LucideIcon;
  items: PaneItem[];
};

export type PaneValue = { group?: string; item?: string };

/**
 * The audit log's two-pane picker, fed by facets: groups on the left (hover or
 * arrow to preview), their items on the right, one search over both. On a
 * phone the panes stack and drill in. Set, it reads "Event  Agent updated ×".
 */
export function PanePicker({
  name,
  idleLabel,
  allLabel,
  searchLabel,
  itemNoun,
  groups,
  value,
  onChange,
  compact,
}: {
  name: string;
  idleLabel: string;
  allLabel: string;
  searchLabel: string;
  /** Pluralized under the right pane's heading: "4 events". */
  itemNoun: [string, string];
  groups: PaneGroup[];
  value: PaneValue;
  onChange: (next: PaneValue) => void;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drilled, setDrilled] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeGroup =
    (value.item
      ? groups.find(
          (g) =>
            (!value.group || g.value === value.group) &&
            g.items.some((i) => i.value === value.item),
        )
      : groups.find((g) => g.value === value.group)) ?? undefined;
  const activeItem = value.item
    ? activeGroup?.items.find((i) => i.value === value.item)
    : undefined;
  const [focused, setFocused] = useState<string | undefined>(
    activeGroup?.value ?? groups[0]?.value,
  );
  const focusedGroup =
    groups.find((g) => g.value === focused) ??
    groups.find((g) => g.items.length > 0) ??
    groups[0];
  const trimmed = query.trim();
  const active = !!(value.group || value.item);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setDrilled(false);
      setFocused(
        activeGroup?.value ?? groups.find((g) => g.items.length)?.value,
      );
    }
  };

  // Anchor on the current selection when the picker opens; carry focus with
  // the drill-in on phones.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on open and drill
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (compact && drilled) return focusFirstPickerRow(root, "right");
      root
        .querySelector<HTMLElement>(
          `[data-nav="left"][data-group="${CSS.escape(focusedGroup?.value ?? "")}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, drilled, compact]);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const commit = (next: PaneValue) => {
    onChange(next);
    setOpen(false);
  };
  const preview = (group: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // A short hover intent, so a diagonal move toward the right pane does not
    // swap it for every row the pointer crosses.
    hoverTimer.current = setTimeout(() => setFocused(group), 110);
  };
  const cancelPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };
  const openGroup = (g: PaneGroup, event: MouseEvent<HTMLButtonElement>) => {
    cancelPreview();
    // A group with nothing under it is a pick in itself.
    if (g.items.length === 0) return commit({ group: g.value });
    setFocused(g.value);
    if (compact) return setDrilled(true);
    if (event.detail === 0)
      requestAnimationFrame(() =>
        focusFirstPickerRow(rootRef.current, "right"),
      );
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (trimmed) focusFirstPickerRow(root, "result");
      else if (compact && drilled) focusFirstPickerRow(root, "right");
      else focusFirstPickerRow(root, "left");
    } else if (event.key === "Enter" && trimmed) {
      event.preventDefault();
      root.querySelector<HTMLElement>('[data-nav="result"]')?.click();
    }
  };
  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const nav = target.dataset.nav;
    if (!nav) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const moved = movePickerFocus({
        root: rootRef.current,
        group: nav,
        from: target,
        delta: event.key === "ArrowDown" ? 1 : -1,
      });
      if (!moved && event.key === "ArrowUp") inputRef.current?.focus();
    } else if (event.key === "ArrowRight" && nav === "left") {
      const g = groups.find((x) => x.value === target.dataset.group);
      if (!g?.items.length) return;
      event.preventDefault();
      setFocused(g.value);
      if (compact) setDrilled(true);
      else focusFirstPickerRow(rootRef.current, "right");
    } else if (event.key === "ArrowLeft" && nav === "right") {
      event.preventDefault();
      if (compact) setDrilled(false);
      else
        rootRef.current
          ?.querySelector<HTMLElement>(
            `[data-nav="left"][data-group="${CSS.escape(focusedGroup?.value ?? "")}"]`,
          )
          ?.focus();
    }
  };

  const leftPane = (
    <div
      className={cn("overflow-y-auto overscroll-contain p-1", PANE_MAX_H)}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <Row
        nav="left"
        selected={!active}
        onClick={() => commit({})}
        className="font-medium"
      >
        {allLabel}
      </Row>
      {groups.map((g) => {
        const isFocused = !compact && g.value === focusedGroup?.value;
        const isActive = g.value === activeGroup?.value;
        return (
          <UnstyledButton
            key={g.value}
            data-nav="left"
            data-group={g.value}
            aria-current={isFocused ? "true" : undefined}
            onMouseEnter={
              compact || !g.items.length ? undefined : () => preview(g.value)
            }
            onMouseLeave={compact ? undefined : cancelPreview}
            onFocus={
              compact || !g.items.length ? undefined : () => setFocused(g.value)
            }
            onClick={(e) => openGroup(g, e)}
            className={cn(
              PICKER_ROW_CLASS,
              isFocused && "bg-accent text-accent-foreground",
            )}
          >
            <GroupIcon icon={g.icon} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate pr-1",
                isActive && "font-medium",
              )}
            >
              {g.label}
            </span>
            {isActive && (
              <>
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
                <span className="sr-only">(filtered)</span>
              </>
            )}
            <Count n={g.count} />
            <ChevronRight
              aria-hidden
              className={cn(
                "-mr-0.5 size-3.5 shrink-0 text-muted-foreground",
                !g.items.length && "invisible",
                !compact && !isFocused && "opacity-0",
              )}
            />
          </UnstyledButton>
        );
      })}
    </div>
  );

  const rightPane = (g: PaneGroup, live: boolean) => (
    <div
      key={g.value}
      aria-hidden={live ? undefined : true}
      className={cn(
        "col-start-1 row-start-1 flex min-w-0 flex-col",
        PANE_MAX_H,
        !live && "invisible",
      )}
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b px-2.5 py-2">
        {compact && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Back to all ${name.toLowerCase()} groups`}
            className="-ml-1"
            onClick={() => setDrilled(false)}
          >
            <ArrowLeft aria-hidden />
          </Button>
        )}
        <PickerTile icon={g.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-5 font-medium">
            {g.label}
          </div>
          <div className="truncate text-xs leading-4 text-muted-foreground">
            {g.items.length} {g.items.length === 1 ? itemNoun[0] : itemNoun[1]}
          </div>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        onWheelCapture={(e) => e.stopPropagation()}
      >
        <Row
          nav={live ? "right" : undefined}
          selected={!value.item && value.group === g.value}
          count={g.count}
          onClick={() => commit({ group: g.value })}
          className="font-medium"
        >
          {g.anyLabel}
        </Row>
        <div aria-hidden className="mx-2 my-1 h-px bg-border" />
        {g.items.map((item) => (
          <Row
            key={item.value}
            nav={live ? "right" : undefined}
            selected={
              value.item === item.value && activeGroup?.value === g.value
            }
            leading={item.leading}
            count={item.count}
            onClick={() => commit({ group: g.value, item: item.value })}
          >
            {item.label}
          </Row>
        ))}
      </div>
    </div>
  );

  const results = trimmed
    ? groups.flatMap((g) => {
        const anyMatch = matchesSearchTokens(trimmed, [g.label, g.anyLabel]);
        const items = g.items.filter((i) =>
          matchesSearchTokens(trimmed, [i.label, i.value, g.label]),
        );
        return anyMatch || items.length ? [{ g, anyMatch, items }] : [];
      })
    : [];
  const searchPane = (
    <div
      className={cn("overflow-y-auto overscroll-contain p-1", PANE_MAX_H)}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      {results.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing matches “{trimmed}”
        </div>
      ) : (
        results.map(({ g, anyMatch, items }) => {
          const Icon = g.icon;
          return (
            <div key={g.value} className="mb-1">
              <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{g.label}</span>
              </div>
              {anyMatch && (
                <Row
                  nav="result"
                  selected={!value.item && value.group === g.value}
                  count={g.count}
                  onClick={() => commit({ group: g.value })}
                >
                  {g.anyLabel}
                </Row>
              )}
              {items.map((item) => (
                <Row
                  key={item.value}
                  nav="result"
                  selected={
                    value.item === item.value && activeGroup?.value === g.value
                  }
                  leading={item.leading}
                  count={item.count}
                  onClick={() => commit({ group: g.value, item: item.value })}
                >
                  {item.label}
                </Row>
              ))}
            </div>
          );
        })
      )}
    </div>
  );

  let body: ReactNode;
  if (trimmed) body = searchPane;
  else if (compact)
    body = drilled && focusedGroup ? rightPane(focusedGroup, true) : leftPane;
  else
    body = (
      <div className="grid grid-cols-[minmax(11rem,auto)_minmax(14rem,1fr)]">
        <div className="border-r">{leftPane}</div>
        {/* Every group's pane shares one cell, so the popover is as tall as
            the tallest list and never jumps while you hover down the left. */}
        <div className="grid min-w-0">
          {groups
            .filter((g) => g.items.length)
            .map((g) => rightPane(g, g.value === focusedGroup?.value))}
        </div>
      </div>
    );

  const TriggerIcon = activeGroup?.icon;
  return (
    <ChipShell active={active}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <UnstyledButton
            data-chip-trigger
            data-idle={active ? undefined : ""}
            aria-label={
              active
                ? `${name}: ${activeItem?.label ?? activeGroup?.label ?? value.item ?? value.group}`
                : idleLabel
            }
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-[inherit] pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "pr-1" : "pr-2",
            )}
          >
            {active ? (
              <>
                <span className="shrink-0 font-normal text-foreground/60">
                  {name}
                </span>
                {activeItem?.leading ??
                  (TriggerIcon && (
                    <TriggerIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-foreground/70"
                    />
                  ))}
                <span className="max-w-[11rem] truncate font-medium">
                  {activeItem?.label ?? activeGroup?.label ?? value.item}
                  {!activeItem && activeGroup && (
                    <span className="font-normal text-foreground/60">
                      {" · any"}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <>
                <span className="truncate">{idleLabel}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </UnstyledButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={`Filter by ${name.toLowerCase()}`}
          collisionPadding={16}
          className={cn(
            "flex w-auto flex-col overflow-hidden p-0",
            compact
              ? "w-[min(22rem,calc(100vw-2rem))]"
              : "max-w-[min(36rem,calc(100vw-2rem))]",
          )}
          // Phones would raise the keyboard over the list on open.
          onOpenAutoFocus={(e) => {
            if (compact) e.preventDefault();
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
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={`${searchLabel}…`}
                aria-label={searchLabel}
                className="h-10 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
            {body}
          </div>
        </PopoverContent>
      </Popover>
      {active && (
        <ClearGlyph label={`Clear ${name}`} onClick={() => onChange({})} />
      )}
    </ChipShell>
  );
}

export type ChipSection = {
  heading: string;
  allLabel: string;
  value: string | undefined;
  options: ChipOption[];
  onChange: (value: string | undefined) => void;
};

/**
 * Several independent filters behind one trigger, like today's "All apps &
 * sources": each section keeps its own value, and the chip reads
 * "Claude Code · gpt-5 ×" once any is set.
 */
export function SectionsChip({
  idleLabel,
  searchPlaceholder,
  sections,
}: {
  idleLabel: string;
  searchPlaceholder: string;
  sections: ChipSection[];
}) {
  const [open, setOpen] = useState(false);
  const picked = sections.flatMap((s) => {
    const o = s.options.find((x) => x.value === s.value);
    return s.value ? [{ s, o }] : [];
  });
  const active = picked.length > 0;
  const text = picked.map(({ s, o }) => o?.label ?? s.value).join(" · ");
  return (
    <ChipShell active={active}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <UnstyledButton
            data-chip-trigger
            data-idle={active ? undefined : ""}
            aria-label={active ? text : idleLabel}
            title={active ? text : undefined}
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-[inherit] pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "pr-1" : "pr-2",
            )}
          >
            {active ? (
              <>
                {picked.length === 1 && picked[0].o?.mark}
                <span className="max-w-[14rem] truncate font-medium">
                  {text}
                </span>
              </>
            ) : (
              <>
                <span className="truncate">{idleLabel}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </UnstyledButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn(MENU_WIDTH, "p-0")}>
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList className="max-h-[min(24rem,calc(var(--radix-popover-content-available-height)-2.5rem))]">
              <CommandEmpty>No matches.</CommandEmpty>
              {sections.map((s, i) => (
                <div key={s.heading}>
                  {i > 0 && <CommandSeparator />}
                  <CommandGroup heading={s.heading}>
                    <OptionItem
                      value={`${s.heading} ${s.allLabel}`}
                      option={{ label: s.allLabel, groupRow: true }}
                      selected={!s.value}
                      onSelect={() => {
                        s.onChange(undefined);
                        setOpen(false);
                      }}
                    />
                    {s.options.map((o) => (
                      <OptionItem
                        key={o.value}
                        value={`${s.heading} ${o.label}`}
                        option={o}
                        selected={s.value === o.value}
                        onSelect={() => {
                          s.onChange(s.value === o.value ? undefined : o.value);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </CommandGroup>
                </div>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {active && (
        <ClearGlyph
          label="Clear apps and models"
          onClick={() => {
            for (const s of sections) if (s.value) s.onChange(undefined);
          }}
        />
      )}
    </ChipShell>
  );
}

// ===== internals =====

const PANE_MAX_H =
  "max-h-[min(22rem,calc(var(--radix-popover-content-available-height)-2.75rem))]";

function Row({
  nav,
  selected,
  leading,
  count,
  onClick,
  className,
  children,
}: {
  nav?: string;
  selected: boolean;
  leading?: ReactNode;
  count?: number;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      data-nav={nav}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        PICKER_ROW_CLASS,
        "min-h-9 md:min-h-8",
        selected && "bg-accent/40 font-medium",
        className,
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate pr-1">{children}</span>
      {selected && <Check aria-hidden className="size-3.5 shrink-0" />}
      {count != null && <Count n={count} />}
    </UnstyledButton>
  );
}

function GroupIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}
