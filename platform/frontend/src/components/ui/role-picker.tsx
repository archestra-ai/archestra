// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Lock,
  Search,
  UserCog,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type RoleGroup,
  type RoleOption,
  type RolePickerProps,
  type RolePickerState,
  roleKindLabels,
  useRolePicker,
} from "@/components/ui/use-role-picker";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one way to assign roles: a slim two-pane menu. The left column lists
 * the preset roles directly (checkable, one line each), then custom roles and
 * the granular areas (tri-state checkbox, count, chevron). The right column
 * shows the hovered or focused area's roles. A role's description and
 * permissions unfold under its row from the chevron at its end (or
 * ArrowRight), one row per pane; nothing floats over the menu. On phones the
 * left list shows first and areas drill in. Every change applies at once: the
 * form around the picker is what saves.
 */
export function RolePicker(props: RolePickerProps) {
  const {
    maxBadgeDisplay = 3,
    placeholder = "Select roles",
    id,
    ariaLabel = "Roles",
    className,
    "data-testid": testId,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
  } = props;
  const picker = useRolePicker(props);
  const { disabled, groups, selected } = picker;
  const compact = useIsMobile();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState("");
  const [drilled, setDrilled] = useState(false);
  // The one unfolded role per pane, keyed by the pane's nav name.
  const [expanded, setExpanded] = useState<Record<string, string | null>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Presets sit in the left column itself, so only areas open on the right.
  const focusedGroup =
    groups.find((group) => group.id === focusedId && group.kind !== "preset") ??
    null;
  const trimmed = query.trim();
  const results = trimmed ? picker.search(trimmed) : [];

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next) {
      setQuery("");
      setDrilled(false);
      setExpanded({});
      // Open on the first area the assignment already draws from, if any.
      const first = selected
        .map((role) => picker.optionsByValue.get(role))
        .find((option) => option && option.kind !== "preset");
      setFocusedId(first?.groupId ?? "");
    }
  };

  // Escape closes the popover and nothing around it. Radix listens for
  // Escape on the document in the capture phase, and a dialog around the
  // picker may run its own copy of that listener; taking the key at the
  // window, one step earlier, keeps it from ever reaching the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Only on open and on drill changes; following every focus change would
  // fight the person's own scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (compact && drilled) {
        focusFirst(root, "right");
        return;
      }
      const row = leftRow(root, focusedGroup?.id);
      row?.scrollIntoView?.({ block: "nearest" });
      if (compact) {
        (row ?? root.querySelector<HTMLElement>('[data-nav="left"]'))?.focus({
          preventScroll: true,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, drilled, compact]);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const cancelPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };
  const previewGroup = (groupId: string) => {
    cancelPreview();
    // A short hover intent so a diagonal move toward the right pane does not
    // swap it for every row the pointer crosses on the way.
    hoverTimer.current = setTimeout(() => setFocusedId(groupId), 110);
  };
  const openGroup = (groupId: string, event: MouseEvent<HTMLButtonElement>) => {
    cancelPreview();
    setFocusedId(groupId);
    if (compact) {
      setDrilled(true);
      return;
    }
    // Enter arrives as a click with no pointer detail: carry focus on.
    if (event.detail === 0) {
      requestAnimationFrame(() => focusFirst(rootRef.current, "right"));
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const root = rootRef.current;
    if (!root || event.key !== "ArrowDown") return;
    event.preventDefault();
    if (trimmed) focusFirst(root, "result");
    else if (compact && drilled) focusFirst(root, "right");
    else focusFirst(root, "left");
  };

  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = event.target;
    const nav = target.dataset.nav;
    if (!nav) return;
    const root = rootRef.current;
    if (nav === "details") {
      // The chevron sits beside its row: any arrow but Right returns to it.
      if (!event.key.startsWith("Arrow") || event.key === "ArrowRight") return;
      event.preventDefault();
      const row = roleRow(root, target.dataset.role);
      row?.focus();
      if (row && event.key !== "ArrowLeft") {
        moveFocus({
          root,
          nav: row.dataset.nav ?? "",
          from: row,
          delta: event.key === "ArrowDown" ? 1 : -1,
        });
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const moved = moveFocus({
        root,
        nav,
        from: target,
        delta: event.key === "ArrowDown" ? 1 : -1,
      });
      if (!moved && event.key === "ArrowUp") inputRef.current?.focus();
    } else if (event.key === "ArrowRight" && target.dataset.group) {
      event.preventDefault();
      setFocusedId(target.dataset.group);
      if (compact) setDrilled(true);
      else requestAnimationFrame(() => focusFirst(root, "right"));
    } else if (event.key === "ArrowRight" && target.dataset.role) {
      // Right on a role unfolds what it grants, under the row.
      event.preventDefault();
      const role = target.dataset.role;
      setExpanded((current) => ({ ...current, [nav]: role }));
    } else if (
      event.key === "ArrowLeft" &&
      target.dataset.role &&
      expanded[nav] === target.dataset.role
    ) {
      // Left folds it again before it means anything else.
      event.preventDefault();
      setExpanded((current) => ({ ...current, [nav]: null }));
    } else if (event.key === " " && target.dataset.group) {
      // Space takes or drops the whole area; Enter opens it.
      const group = groups.find((entry) => entry.id === target.dataset.group);
      if (group?.kind !== "granular") return;
      event.preventDefault();
      picker.toggleGroup(group);
    } else if (nav === "right" && event.key === "ArrowLeft") {
      event.preventDefault();
      if (compact) setDrilled(false);
      else leftRow(root, focusedGroup?.id)?.focus();
    }
  };

  const stopScrollChaining = {
    // Keep wheel and touch scrolling inside the pane when a dialog around the
    // popover locks page scroll.
    onWheelCapture: (event: { stopPropagation: () => void }) =>
      event.stopPropagation(),
    onTouchMoveCapture: (event: { stopPropagation: () => void }) =>
      event.stopPropagation(),
  };

  const renderRole = (option: RoleOption, nav: string, showGroup = false) => (
    <RoleRow
      key={option.value}
      option={option}
      picker={picker}
      nav={nav}
      compact={compact}
      showGroup={showGroup}
      expanded={expanded[nav] === option.value}
      onToggleExpanded={() =>
        setExpanded((current) => ({
          ...current,
          [nav]: current[nav] === option.value ? null : option.value,
        }))
      }
    />
  );

  const renderGroupRow = (group: RoleGroup) => {
    const state = picker.groupState(group);
    const isFocused = !compact && group.id === focusedGroup?.id;
    return (
      <div
        key={group.id}
        className={cn(
          "flex items-center rounded-sm pl-2 transition-colors hover:bg-accent/60",
          compact ? "min-h-10" : "h-7",
          isFocused && "bg-accent text-accent-foreground hover:bg-accent",
        )}
      >
        {group.kind === "granular" ? (
          <Checkbox
            aria-label={`Select all ${group.name} roles`}
            checked={state.checked}
            disabled={disabled || state.disabled}
            onCheckedChange={() => picker.toggleGroup(group)}
            className="relative after:absolute after:-inset-1.5"
          />
        ) : (
          <UserCog
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <UnstyledButton
          data-nav="left"
          data-group={group.id}
          aria-current={isFocused ? "true" : undefined}
          onMouseEnter={compact ? undefined : () => previewGroup(group.id)}
          onMouseLeave={compact ? undefined : cancelPreview}
          onFocus={compact ? undefined : () => setFocusedId(group.id)}
          onClick={(event) => openGroup(group.id, event)}
          className="flex min-w-0 flex-1 cursor-default select-none items-center gap-1.5 self-stretch rounded-sm pr-1.5 pl-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              state.selectedCount > 0 && "font-medium",
            )}
          >
            {group.name}
          </span>
          {state.selectedCount > 0 ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[11px] leading-4 font-medium text-primary tabular-nums">
              {state.selectedCount}
              <span className="sr-only"> selected</span>
            </span>
          ) : null}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              isFocused ? "text-foreground" : "text-muted-foreground/60",
            )}
          />
        </UnstyledButton>
      </div>
    );
  };

  const customGroup = groups.find((group) => group.kind === "custom");
  const paneHeight = compact ? PANE_HEIGHT_MOBILE : PANE_HEIGHT;

  const leftPane = (
    <nav
      aria-label="Roles and role areas"
      className={cn("overflow-y-auto overscroll-contain p-1", paneHeight)}
      {...stopScrollChaining}
    >
      <SectionLabel>{roleKindLabels.preset}</SectionLabel>
      {picker.presets.map((option) => renderRole(option, "left"))}
      {picker.presets.length === 0 && picker.isPending ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Loading roles…
        </p>
      ) : null}
      {customGroup ? (
        <div className="mt-1 border-t pt-1">{renderGroupRow(customGroup)}</div>
      ) : null}
      <SectionLabel className={customGroup ? undefined : "mt-1 border-t pt-2"}>
        {roleKindLabels.granular}
      </SectionLabel>
      {picker.granularGroups.map(renderGroupRow)}
    </nav>
  );

  const focusedState = focusedGroup ? picker.groupState(focusedGroup) : null;
  const canClearFocused =
    !!focusedState &&
    focusedState.selectedCount > 0 &&
    selected.length - focusedState.selectedCount >= picker.minSelected;

  const rightPane =
    focusedGroup && focusedState ? (
      <div className={cn("flex min-w-0 flex-col", paneHeight)}>
        {compact ? (
          <div className="flex shrink-0 items-center gap-1 border-b pr-3 pl-1">
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label="Back to all roles"
              className="shrink-0"
              onClick={() => setDrilled(false)}
            >
              <ArrowLeft aria-hidden />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {focusedGroup.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {focusedState.selectedCount} of {focusedState.total}
            </span>
          </div>
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          {...stopScrollChaining}
        >
          {focusedGroup.options.map((option) => renderRole(option, "right"))}
          {focusedGroup.options.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No roles here yet.
            </p>
          ) : null}
        </div>
      </div>
    ) : (
      <div
        className={cn(
          "flex items-center justify-center px-6 text-center text-xs text-muted-foreground",
          paneHeight,
        )}
      >
        Point at an area to see its roles.
      </div>
    );

  const searchPane = (
    <div
      className={cn("overflow-y-auto overscroll-contain p-1", paneHeight)}
      {...stopScrollChaining}
    >
      {results.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="max-w-full truncate text-sm font-medium">
            No roles match “{trimmed}”
          </p>
          <p className="text-xs text-muted-foreground">
            Try a role name or a permission such as{" "}
            <span className="font-mono text-[11px]">agent:read</span>.
          </p>
          <Button
            variant="outline"
            size={compact ? "lg" : "xs"}
            className="mt-2"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            Clear search
          </Button>
        </div>
      ) : (
        results.map(({ option }) => renderRole(option, "result", true))
      )}
    </div>
  );

  const singleLine = /(^|\s)flex-nowrap(\s|$)/.test(className ?? "");
  const visible = selected.slice(0, maxBadgeDisplay);
  const hiddenCount = selected.length - visible.length;
  // The area "Clear" belongs to whatever the right pane is showing.
  const showAreaClear =
    !trimmed && !!focusedGroup && (!compact || drilled) && canClearFocused;

  return (
    <Popover open={!disabled && open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          id={id}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-disabled={disabled}
          data-testid={testId}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (
              event.key === "Enter" ||
              event.key === " " ||
              event.key === "ArrowDown"
            ) {
              event.preventDefault();
              handleOpenChange(!open);
            }
          }}
          className={cn(
            "flex h-auto min-h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
            open && "border-ring ring-[3px] ring-ring/50",
            disabled && "cursor-not-allowed opacity-50",
            className,
            singleLine && "h-9 overflow-hidden",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1",
              singleLine ? "flex-nowrap overflow-hidden" : "flex-wrap",
            )}
          >
            {selected.length === 0 ? (
              <span className="truncate px-1 text-muted-foreground">
                {picker.isPending ? "Loading roles…" : placeholder}
              </span>
            ) : (
              <>
                {visible.map((role) => {
                  const label = picker.labelFor(role);
                  const locked = disabled || picker.isLastRequired(role);
                  return (
                    <Badge
                      key={role}
                      variant="secondary"
                      className="max-w-full min-w-0 shrink gap-0.5 overflow-hidden pr-1"
                    >
                      <span className="min-w-0 truncate">{label}</span>
                      {locked ? null : (
                        <UnstyledButton
                          aria-label={`Remove ${label}`}
                          className="relative shrink-0 rounded-full text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            picker.remove(role);
                          }}
                        >
                          <X aria-hidden className="size-3" />
                        </UnstyledButton>
                      )}
                    </Badge>
                  );
                })}
                {hiddenCount > 0 ? (
                  <Badge variant="outline" className="shrink-0 tabular-nums">
                    +{hiddenCount}
                  </Badge>
                ) : null}
              </>
            )}
          </div>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        aria-label={ariaLabel}
        className={cn(
          "flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0",
          compact
            ? "w-[min(22rem,calc(100vw-2rem))]"
            : "w-[min(32rem,calc(100vw-2rem))]",
        )}
        // Phones would raise the keyboard over the list on open.
        onOpenAutoFocus={(event) => {
          if (compact) event.preventDefault();
        }}
        onKeyDown={onNavKeyDown}
      >
        <div ref={rootRef} className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b pr-1 pl-3">
            <Search
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search roles or permissions…"
              aria-label="Search roles"
              className={cn(
                "rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent",
                compact ? "h-11" : "h-8 md:text-sm",
              )}
            />
            {query ? (
              <Button
                variant="ghost"
                size={compact ? "icon-lg" : "icon-xs"}
                aria-label="Clear search"
                className={compact ? undefined : "-my-0.5"}
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </div>
          {trimmed ? (
            searchPane
          ) : compact ? (
            drilled && focusedGroup ? (
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
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 border-t bg-muted/30 pr-1 pl-3",
              compact ? "py-1.5 pr-2" : "h-8",
            )}
          >
            <div
              aria-live="polite"
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums"
            >
              {selected.length === 0 ? (
                <span>No roles selected</span>
              ) : (
                <span>
                  <span className="font-medium text-foreground">
                    {selected.length} {selected.length === 1 ? "role" : "roles"}
                  </span>
                  {" · "}
                  {picker.effectivePermissionCount}{" "}
                  {picker.effectivePermissionCount === 1
                    ? "permission"
                    : "permissions"}
                </span>
              )}
            </div>
            {showAreaClear && focusedGroup ? (
              <Button
                variant="ghost"
                size={compact ? "lg" : "xs"}
                className="min-w-0 shrink text-muted-foreground"
                onClick={() => picker.clearGroup(focusedGroup)}
              >
                <span className="truncate">Clear {focusedGroup.name}</span>
              </Button>
            ) : picker.canClear ? (
              <Button
                variant="ghost"
                size={compact ? "lg" : "xs"}
                className="text-muted-foreground"
                onClick={picker.clear}
              >
                <span>Clear all</span>
              </Button>
            ) : null}
            {compact ? (
              <Button size="lg" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Desktop: 2rem search + 17.5rem pane + 2rem footer and two hairlines, just
 * under 22rem in all.
 */
const PANE_HEIGHT =
  "h-[min(17.5rem,calc(var(--radix-popover-content-available-height)-4.25rem))]";
const PANE_HEIGHT_MOBILE =
  "h-[min(22rem,calc(var(--radix-popover-content-available-height)-6.75rem))]";

function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: string;
}) {
  return (
    <div
      className={cn(
        "px-2 pt-1.5 pb-1 text-[11px] leading-4 font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One line: checkbox, name, a quiet trailing hint, and a chevron that unfolds
 * the details under the row.
 */
function RoleRow({
  option,
  picker,
  nav,
  compact,
  showGroup,
  expanded,
  onToggleExpanded,
}: {
  option: RoleOption;
  picker: RolePickerState;
  nav: string;
  compact: boolean;
  /** Search results span groups, so each row names its own. */
  showGroup: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // The pane scrolls to keep the unfolded block in view; its size never moves.
  useEffect(() => {
    if (expanded) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  const checked = picker.isSelected(option.value);
  const locked = picker.isLocked(option);
  const lastRequired = picker.isLastRequired(option.value);
  const covering = picker.coveredBy(option);
  const blocked = picker.disabled || locked || lastRequired;
  const groupLabel =
    option.kind === "granular" ? option.groupName : roleKindLabels[option.kind];
  const trailing = locked
    ? "Can't grant"
    : lastRequired
      ? "Required"
      : covering
        ? `Included in ${covering.label}`
        : showGroup
          ? groupLabel
          : null;

  return (
    <div
      ref={rowRef}
      className={cn(
        "rounded-sm transition-colors hover:bg-accent/60 focus-within:bg-accent/60",
        expanded && "bg-accent/40",
      )}
    >
      <div className={cn("flex items-stretch", compact ? "min-h-10" : "h-7")}>
        <UnstyledButton
          role="checkbox"
          aria-checked={checked}
          aria-disabled={blocked}
          data-nav={nav}
          data-role={option.value}
          onClick={() => picker.toggle(option)}
          className={cn(
            "flex min-w-0 flex-1 select-none items-center gap-2 rounded-sm pr-1 pl-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            blocked ? "cursor-not-allowed" : "cursor-default",
          )}
        >
          {locked ? (
            <Lock
              aria-hidden
              className="size-4 shrink-0 p-px text-muted-foreground/70"
            />
          ) : (
            <span
              aria-hidden
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs dark:bg-input/30",
                checked &&
                  "border-primary bg-primary text-primary-foreground dark:bg-primary",
                lastRequired && "opacity-60",
              )}
            >
              {checked ? <Check className="size-3.5" /> : null}
            </span>
          )}
          {/* One clipped line that wraps: a hint that does not fit beside the
              whole name drops to a second, hidden line instead of squeezing
              it. The expanded block carries the same reason in full. */}
          <span className="flex h-5 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden leading-5">
            <span
              className={cn(
                "max-w-full flex-[1_0_auto] truncate",
                checked && "font-medium",
                locked && "text-muted-foreground",
              )}
            >
              {option.label}
            </span>
            {trailing ? (
              <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                {trailing}
              </span>
            ) : null}
          </span>
        </UnstyledButton>
        <UnstyledButton
          data-nav="details"
          data-role={option.value}
          aria-label={`${expanded ? "Hide" : "Show"} what ${option.label} grants`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className={cn(
            "flex shrink-0 items-center justify-center self-stretch rounded-sm text-muted-foreground/60 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            compact ? "w-10" : "w-6",
            expanded && "text-foreground",
          )}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </UnstyledButton>
      </div>
      {expanded ? (
        <div className="pr-2 pb-1.5 pl-8 text-xs">
          <RoleDetails option={option} picker={picker} compact={compact} />
        </div>
      ) : null}
    </div>
  );
}

/** The block under an unfolded row: description, reasons, permissions. */
function RoleDetails({
  option,
  picker,
  compact,
}: {
  option: RoleOption;
  picker: RolePickerState;
  compact: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const locked = picker.isLocked(option);
  const missing = locked ? picker.missingFor(option) : [];
  const covering = picker.coveredBy(option);
  const total = option.permissions.length;
  const shown = showAll
    ? option.permissions
    : option.permissions.slice(0, MAX_LISTED_PERMISSIONS);
  const more = total - MAX_LISTED_PERMISSIONS;
  return (
    <div className="space-y-1 leading-4 break-words">
      {option.description ? (
        <p className="text-muted-foreground">{option.description}</p>
      ) : null}
      {locked ? (
        <p>
          You can't grant this. It needs{" "}
          <span className="font-medium">
            {missing
              .slice(0, 2)
              .map(
                (key) =>
                  option.permissions.find((entry) => entry.key === key)
                    ?.label ?? key,
              )
              .join(", ")}
          </span>
          {missing.length > 2 ? (
            <span> and {missing.length - 2} more</span>
          ) : null}
          , which you don't hold.
        </p>
      ) : null}
      {picker.isLastRequired(option.value) ? (
        <p>
          {picker.minSelected === 1
            ? "At least one role is required. Add another to remove this one."
            : `At least ${picker.minSelected} roles are required.`}
        </p>
      ) : null}
      {covering ? (
        <p>Included in {covering.label}, which already grants all of this.</p>
      ) : null}
      {total === 0 ? (
        <p className="text-muted-foreground">No permissions</p>
      ) : (
        <ul
          aria-label={`${total} ${total === 1 ? "permission" : "permissions"}`}
          className="flex flex-wrap gap-1 pt-0.5"
        >
          {shown.map((permission) => (
            <li
              key={permission.key}
              className="max-w-full truncate rounded-sm border bg-background px-1.5 text-[11px] leading-[1.125rem]"
            >
              {permission.label}
            </li>
          ))}
          {more > 0 ? (
            <li>
              <UnstyledButton
                aria-expanded={showAll}
                onClick={() => setShowAll((current) => !current)}
                className={cn(
                  "rounded-sm px-1 text-[11px] leading-[1.125rem] font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60",
                  compact && "inline-flex min-h-10 items-center",
                )}
              >
                {showAll ? "Show fewer" : `+${more} more`}
              </UnstyledButton>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

const MAX_LISTED_PERMISSIONS = 8;

function roleRow(root: HTMLElement | null, role: string | undefined) {
  if (!root || !role) return null;
  return root.querySelector<HTMLElement>(
    `[role="checkbox"][data-role="${CSS.escape(role)}"]`,
  );
}

function leftRow(root: HTMLElement | null, groupId: string | undefined) {
  if (!root || !groupId) return null;
  return root.querySelector<HTMLElement>(
    `[data-nav="left"][data-group="${groupId}"]`,
  );
}

function focusFirst(root: HTMLElement | null, nav: string) {
  root?.querySelector<HTMLElement>(`[data-nav="${nav}"]`)?.focus();
}

function moveFocus({
  root,
  nav,
  from,
  delta,
}: {
  root: HTMLElement | null;
  nav: string;
  from: HTMLElement;
  delta: number;
}): boolean {
  if (!root) return false;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(`[data-nav="${nav}"]`),
  );
  const next = items[items.indexOf(from) + delta];
  if (!next) return false;
  next.focus();
  next.scrollIntoView?.({ block: "nearest" });
  return true;
}
