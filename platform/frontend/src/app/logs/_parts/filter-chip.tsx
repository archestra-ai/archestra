"use client";

import { Check, ChevronDown, type LucideIcon, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export type ChipOption = {
  value: string;
  label: string;
  count?: number;
  /** Small leading mark (a source dot, an avatar). */
  mark?: ReactNode;
  /** Options sharing a group render under one heading. */
  group?: string;
  /** Render as the group's own row ("All in <group>"), bolder. */
  groupRow?: boolean;
  /** What the set chip shows, when shorter than `label`. */
  selectedLabel?: string;
  /** A muted second line under the label. */
  description?: string;
  /** Today's own option renderer, in place of mark + label. */
  content?: ReactNode;
};

/**
 * A Linear-style filter chip: "All agents" while idle; "Agent  SRE Copilot ×"
 * once set. The × clears it without opening the menu.
 */
export function FilterChip({
  name,
  idleLabel,
  value,
  options,
  onChange,
  searchable,
  searchPlaceholder,
  allLabel,
  icon: Icon,
  className,
  width,
}: {
  /** Short noun shown before the value once the chip is set. */
  name: string;
  idleLabel: string;
  value: string | undefined;
  options: ChipOption[];
  onChange: (value: string | undefined) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** A first "All …" row that clears the filter, like today's selectors. */
  allLabel?: string;
  icon?: LucideIcon;
  className?: string;
  /** Extra width classes, e.g. a wider minimum for long labels. */
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const active = value != null;
  const groups = groupBy(options);

  return (
    <ChipShell active={active} className={className}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <UnstyledButton
            data-chip-trigger
            data-idle={active ? undefined : ""}
            aria-label={
              active ? `${name}: ${selected?.label ?? value}` : idleLabel
            }
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-[inherit] pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "pr-1" : "pr-2",
            )}
          >
            {Icon && (
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {active ? (
              <>
                <span className="shrink-0 font-normal text-foreground/60">
                  {name}
                </span>
                {selected?.mark}
                <span className="max-w-[10rem] truncate font-medium">
                  {selected?.selectedLabel ?? selected?.label ?? value}
                </span>
              </>
            ) : (
              <>
                <span className="truncate">{idleLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </UnstyledButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn(MENU_WIDTH, "p-0", width)}>
          <Command>
            {searchable && (
              <CommandInput
                placeholder={
                  searchPlaceholder ?? `Search ${name.toLowerCase()}s…`
                }
              />
            )}
            <CommandList className="max-h-[min(20rem,var(--radix-popover-content-available-height))]">
              <CommandEmpty>No matches.</CommandEmpty>
              {allLabel && (
                <CommandGroup>
                  <OptionItem
                    value={allLabel}
                    option={{ label: allLabel, groupRow: true }}
                    selected={!active}
                    onSelect={() => {
                      onChange(undefined);
                      setOpen(false);
                    }}
                  />
                </CommandGroup>
              )}
              {groups.map(([group, items], gi) => (
                <ChipGroup
                  key={group ?? "_"}
                  heading={group}
                  first={gi === 0 && !allLabel}
                >
                  {items.map((o) => (
                    <OptionItem
                      key={o.value}
                      value={`${o.group ?? ""} ${o.label}`}
                      option={o}
                      selected={o.value === value}
                      onSelect={() => {
                        onChange(o.value === value ? undefined : o.value);
                        setOpen(false);
                      }}
                    />
                  ))}
                </ChipGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {active && (
        <ClearGlyph
          label={`Clear ${name}`}
          onClick={() => onChange(undefined)}
        />
      )}
    </ChipShell>
  );
}

/**
 * Menus size to their content: never narrower than a short label list needs,
 * never wider than the phone they open on.
 */
export const MENU_WIDTH =
  "w-auto min-w-[11rem] max-w-[min(20rem,calc(100vw-2rem))]";

/**
 * One menu option: `[mark] label ........ ✓ count`. No reserved gutter on the
 * left; the selected row is tinted and carries a check beside its count.
 */
export function OptionItem({
  option,
  value,
  selected,
  onSelect,
}: {
  option: Pick<
    ChipOption,
    "label" | "count" | "mark" | "groupRow" | "description" | "content"
  >;
  /** cmdk's search value. */
  value: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={value}
      onSelect={onSelect}
      className={cn(
        "min-h-9 gap-2 md:min-h-8",
        selected && "bg-accent/40 font-medium",
      )}
    >
      {option.content ? (
        <span className="flex min-w-0 flex-1 items-center pr-2">
          {option.content}
        </span>
      ) : (
        <>
          {option.mark}
          <span
            className={cn(
              "min-w-0 flex-1 pr-2",
              option.groupRow && "font-medium",
            )}
          >
            <span className="block truncate">{option.label}</span>
            {option.description && (
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {option.description}
              </span>
            )}
          </span>
        </>
      )}
      {selected && (
        <>
          <Check aria-hidden className="size-3.5 text-foreground" />
          <span className="sr-only">(applied)</span>
        </>
      )}
      {option.count != null && <Count n={option.count} />}
    </CommandItem>
  );
}

/** A two-state chip, e.g. "Problems only". */
export function ToggleChip({
  label,
  icon: Icon,
  pressed,
  count,
  onChange,
}: {
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  count?: number;
  onChange: (pressed: boolean) => void;
}) {
  return (
    <ChipShell active={pressed}>
      <UnstyledButton
        data-chip-trigger
        aria-pressed={pressed}
        onClick={() => onChange(!pressed)}
        className="flex h-full items-center gap-1.5 rounded-[inherit] px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Icon
          className={cn(
            "size-3.5",
            pressed ? "text-red-500" : "text-muted-foreground",
          )}
        />
        <span className={cn(pressed && "font-medium")}>{label}</span>
        {count != null && <Count n={count} />}
      </UnstyledButton>
    </ChipShell>
  );
}

export function ChipShell({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  // Today's filter-bar look (filterControlClass), split into a trigger and a
  // clear glyph, and a touch taller on phones for the thumb.
  return (
    <div
      className={filterControlClass({
        active,
        className: cn(
          "inline-flex max-w-none shrink-0 items-center gap-0 rounded-md border px-0 has-[>svg]:px-0 transition-colors",
          !active && "hover:bg-accent/50 dark:hover:bg-input/30",
          className,
        ),
      })}
    >
      {children}
    </div>
  );
}

export function ClearGlyph({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      aria-label={label}
      onClick={onClick}
      className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-primary/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <X className="size-3.5" />
    </UnstyledButton>
  );
}

export function Count({ n }: { n: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
      {n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString()}
    </span>
  );
}

// ===== internals =====

function ChipGroup({
  heading,
  first,
  children,
}: {
  heading?: string;
  first: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {!first && <CommandSeparator />}
      <CommandGroup heading={heading}>{children}</CommandGroup>
    </>
  );
}

function groupBy(options: ChipOption[]) {
  const map = new Map<string | undefined, ChipOption[]>();
  for (const o of options) {
    const list = map.get(o.group) ?? [];
    list.push(o);
    map.set(o.group, list);
  }
  return [...map.entries()];
}
