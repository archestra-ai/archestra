"use client";

import {
  Boxes,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type DefaultUserLimit,
  type UserLimitUsage,
  type UserLimitUsageSummary,
  useUserLimitUsagePages,
} from "@/lib/default-user-limit.query";
import { cn } from "@/lib/utils/tailwind";
import {
  ALL_ENVIRONMENTS,
  DotList,
  formatDate,
  formatLimit,
  formatRelative,
  formatUsd,
  pluralUsers,
  type RosterFilter,
  STATUS_META,
  UNLIMITED_DOT,
  UserAvatar,
} from "./user-limits-shared";

type Environment = { id: string; name: string };

/**
 * Every member with their spend against the limit that applies to them,
 * closest to their limit first, a page at a time as the list scrolls.
 */
export function RosterSheet({
  open,
  onOpenChange,
  environments,
  environmentSummary,
  totalUsers,
  defaults,
  filter,
  onFilterChange,
  environmentFilter,
  onEnvironmentFilterChange,
  search,
  onSearchChange,
  focusId,
  canManage,
  onReset,
  onResetAllAtLimit,
  onCustomLimit,
  onRemoveCustomLimit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environments: Environment[];
  environmentSummary: UserLimitUsageSummary["environments"];
  totalUsers: number;
  defaults: DefaultUserLimit[];
  filter: RosterFilter;
  onFilterChange: (filter: RosterFilter) => void;
  environmentFilter: string;
  onEnvironmentFilterChange: (environmentId: string) => void;
  search: string;
  onSearchChange: (search: string) => void;
  focusId: string | null;
  canManage: boolean;
  onReset: (rows: UserLimitUsage[]) => void;
  onResetAllAtLimit: (params: {
    count: number;
    environmentId?: string;
    search?: string;
  }) => void;
  onCustomLimit: (row: UserLimitUsage) => void;
  onRemoveCustomLimit: (row: UserLimitUsage) => void;
}) {
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the sheet's portal mounts after the first effect pass,
  // so the observer has to re-attach once the sentinel actually exists.
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);

  const environmentId =
    environmentFilter === ALL_ENVIRONMENTS ? undefined : environmentFilter;
  const query = useUserLimitUsagePages({
    filters: {
      search: search.trim() || undefined,
      environmentId,
      status: filter === "all" ? undefined : filter,
    },
    pageSize: PAGE_SIZE,
    enabled: open,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.data);
  const summary = pages[0]?.summary;
  const matching = pages[0]?.pagination.total ?? 0;

  // A new query starts from the top again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query values are the trigger
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter, environmentFilter, search, open]);

  useEffect(() => {
    const element = sentinel;
    if (!open || !hasNextPage || isFetchingNextPage || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, sentinel, fetchNextPage]);

  const focusLoaded =
    focusId !== null && rows.some((row) => row.userId === focusId);
  useEffect(() => {
    if (!open || !focusId || !focusLoaded) return;
    const timer = window.setTimeout(() => {
      rowRefs.current
        .get(focusId)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, focusId, focusLoaded]);

  const orgDefault = defaults.find((d) => d.environmentId === null);
  const counts: Record<RosterFilter, number> = {
    all: summary?.total ?? 0,
    at: summary?.at ?? 0,
    near: summary?.near ?? 0,
    custom: summary?.custom ?? 0,
    none: summary?.none ?? 0,
  };
  // Empty buckets stay out of the way unless they are the active one.
  const shownFilters = FILTERS.filter(
    (f) => f.value === "all" || counts[f.value] > 0 || filter === f.value,
  );
  const environmentLabel = environmentId
    ? (environments.find((env) => env.id === environmentId)?.name ?? null)
    : null;
  const hasFilters =
    filter !== "all" || environmentFilter !== ALL_ENVIRONMENTS || !!search;
  const clearFilters = () => {
    onFilterChange("all");
    onEnvironmentFilterChange(ALL_ENVIRONMENTS);
    onSearchChange("");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-[640px]"
        // Keep the keyboard from popping on mobile; Tab reaches search first.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Users and their limits</SheetTitle>
          <SheetDescription>
            Spend this window against the limit that applies to each user.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-2 border-b px-4 py-3">
          <FilterBar
            onClearFilters={hasFilters ? clearFilters : undefined}
            search={
              <SearchInput
                value={search}
                onSearchChange={onSearchChange}
                syncQueryParams={false}
                debounceMs={250}
                placeholder="Search users"
                className={cn(filterSearchClass, "md:min-w-[10rem]")}
              />
            }
          >
            {environments.length > 0 ? (
              <FilterSelect
                value={environmentFilter}
                onValueChange={onEnvironmentFilterChange}
                inactiveValue={ALL_ENVIRONMENTS}
                placeholder="All environments"
                ariaLabel="Environment"
                showSearch={environments.length > 6}
                items={[
                  {
                    value: ALL_ENVIRONMENTS,
                    label: "All environments",
                    content: (
                      <OptionLabel
                        label="All environments"
                        hint={pluralUsers(totalUsers)}
                      />
                    ),
                    selectedContent: "All environments",
                  },
                  ...environments.map((env) => {
                    const override = defaults.find(
                      (d) => d.environmentId === env.id,
                    );
                    const users =
                      environmentSummary.find(
                        (entry) => entry.environmentId === env.id,
                      )?.users ?? 0;
                    return {
                      value: env.id,
                      label: env.name,
                      content: (
                        <OptionLabel
                          label={env.name}
                          hint={`${pluralUsers(users)} · ${override ? `${formatLimit(override.limitValue)} override` : orgDefault ? "organization default" : "no limit"}`}
                        />
                      ),
                      selectedContent: env.name,
                    };
                  }),
                ]}
              />
            ) : null}
            <FilterSelect
              value={filter}
              onValueChange={(next) => onFilterChange(next as RosterFilter)}
              placeholder="All statuses"
              ariaLabel="Status"
              showSearch={false}
              items={shownFilters.map((f) => ({
                value: f.value,
                label: f.label,
                content: (
                  <OptionLabel
                    dot={f.dot}
                    withDotSlot
                    label={f.label}
                    hint={summary ? pluralUsers(counts[f.value]) : undefined}
                  />
                ),
                selectedContent: f.dot ? (
                  <OptionLabel dot={f.dot} withDotSlot label={f.label} />
                ) : (
                  f.label
                ),
              }))}
            />
          </FilterBar>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {query.isPending ? (
            <div aria-busy>
              {SKELETON_ROWS.map((key) => (
                <RowSkeleton key={key} />
              ))}
            </div>
          ) : query.isError ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle className="text-base">
                  Couldn't load users
                </EmptyTitle>
                <EmptyDescription>
                  Something went wrong reading usage. Try again.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void query.refetch()}
                >
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
          ) : rows.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle className="text-base">No users match</EmptyTitle>
                <EmptyDescription>
                  Try another name, environment or status.
                </EmptyDescription>
              </EmptyHeader>
              {hasFilters ? (
                <EmptyContent>
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <ul className="divide-y" aria-busy={isFetchingNextPage}>
              {rows.map((row) => (
                <RosterRow
                  key={row.userId}
                  row={row}
                  showEnvironment={environments.length > 0}
                  focused={focusId === row.userId}
                  canManage={canManage}
                  refCallback={(element) => {
                    if (element) rowRefs.current.set(row.userId, element);
                    else rowRefs.current.delete(row.userId);
                  }}
                  onReset={() => onReset([row])}
                  onCustomLimit={() => onCustomLimit(row)}
                  onRemoveCustomLimit={() => onRemoveCustomLimit(row)}
                />
              ))}
              {hasNextPage ? (
                <li ref={setSentinel} aria-hidden>
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <SheetFooter className="mt-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
          <span>
            {!summary
              ? null
              : hasNextPage
                ? `Showing ${rows.length.toLocaleString("en-US")} of ${matching.toLocaleString("en-US")}`
                : `${formatUsd(summary.spent)} spent by ${pluralUsers(summary.total)}${environmentLabel ? ` in ${environmentLabel}` : ""}`}
          </span>
          {canManage && filter === "at" && counts.at > 1 ? (
            // Bulk reset lives with the at-limit view it acts on.
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                onResetAllAtLimit({
                  count: counts.at,
                  environmentId,
                  search: search.trim() || undefined,
                })
              }
            >
              <RotateCcw />
              <span>{`Reset all ${counts.at}`}</span>
            </Button>
          ) : summary?.resetsAt ? (
            <span>{`Next reset ${formatDate(summary.resetsAt)}`}</span>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ===
// Internal components and constants

/** Users per page; the API pages the same way. */
const PAGE_SIZE = 50;

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

const FILTERS: { value: RosterFilter; label: string; dot?: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "at", label: "At limit", dot: STATUS_META.at.dot },
  { value: "near", label: "Near limit", dot: STATUS_META.near.dot },
  { value: "custom", label: "Custom limit" },
  { value: "none", label: "No limit", dot: UNLIMITED_DOT },
];

/** A select option: optional status dot, label, and a hint line below. */
function OptionLabel({
  dot,
  withDotSlot,
  label,
  hint,
}: {
  dot?: string;
  withDotSlot?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* Every status option keeps the dot's slot so the labels line up. */}
      {withDotSlot ? (
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            dot ?? "bg-transparent",
          )}
        />
      ) : null}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {hint ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {hint}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Two lines per user: who (name and email) with spend on the right, then the
 * usage bar with its percent, where the limit comes from, and anything
 * notable. A custom limit's reason gets a third line.
 */
function RosterRow({
  row,
  showEnvironment,
  focused,
  canManage,
  refCallback,
  onReset,
  onCustomLimit,
  onRemoveCustomLimit,
}: {
  row: UserLimitUsage;
  showEnvironment: boolean;
  focused: boolean;
  canManage: boolean;
  refCallback: (element: HTMLLIElement | null) => void;
  onReset: () => void;
  onCustomLimit: () => void;
  onRemoveCustomLimit: () => void;
}) {
  const meta = STATUS_META[row.status];
  const percent = row.percent ?? 0;
  const limitValue = row.limitValue;
  const unlimited = limitValue === null;
  const onPace =
    !unlimited &&
    row.status !== "at" &&
    row.projectedSpend !== null &&
    row.projectedSpend >= limitValue;
  const width = Math.min(percent, 100);

  return (
    <li
      ref={refCallback}
      className={cn(
        "relative flex items-center gap-3 px-4 py-2.5 transition-colors",
        focused && "bg-accent/50",
      )}
    >
      {focused ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-0.5 bg-primary"
        />
      ) : null}
      <UserAvatar row={row} className="size-8" ringed />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium sm:max-w-[60%] sm:shrink-0">
              {row.name}
            </span>
            {/* Phones keep the name whole; the email is still searchable. */}
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
              {row.email}
            </span>
          </div>
          <span className="shrink-0 text-sm tabular-nums">
            <span>{formatUsd(row.spent)}</span>
            {unlimited ? null : (
              <span className="text-muted-foreground">
                {` / ${formatLimit(limitValue)}`}
              </span>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {unlimited ? (
            <div
              aria-hidden
              className="h-1 min-w-24 flex-1 rounded-full border border-dashed border-muted-foreground/40"
            />
          ) : (
            <div
              role="progressbar"
              aria-label={`${row.name} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(width)}
              aria-valuetext={`${percent.toFixed(1)}% used`}
              className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  meta.dot,
                )}
                style={{ width: `${Math.max(width, 1.5)}%` }}
              />
            </div>
          )}
          <DotList
            className="shrink-0 text-muted-foreground"
            items={[
              unlimited
                ? null
                : {
                    key: "percent",
                    node: (
                      <span className={cn("tabular-nums", meta.text)}>
                        {`${Math.round(percent)}%`}
                      </span>
                    ),
                  },
              {
                key: "source",
                node: (
                  <LimitSource row={row} showEnvironment={showEnvironment} />
                ),
              },
              onPace && row.projectedSpend !== null
                ? {
                    key: "pace",
                    node: (
                      <span
                        className={cn("tabular-nums", STATUS_META.near.text)}
                      >
                        {`on pace for ${formatLimit(Math.round(row.projectedSpend))}`}
                      </span>
                    ),
                  }
                : null,
              row.lastResetAt
                ? {
                    key: "reset",
                    node: (
                      <span>
                        {`reset${row.lastResetByName ? ` by ${row.lastResetByName}` : ""} ${formatRelative(row.lastResetAt)}`}
                      </span>
                    ),
                  }
                : null,
            ]}
          />
        </div>
        {row.source === "custom" && row.customReason ? (
          <p
            title={row.customReason}
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <MessageSquareText aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Reason: </span>
            <span className="truncate">{row.customReason}</span>
          </p>
        ) : null}
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          {row.status === "at" ? (
            <Button size="xs" variant="outline" onClick={onReset}>
              <RotateCcw />
              <span className="sr-only sm:not-sr-only">Reset</span>
            </Button>
          ) : null}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Actions for ${row.name}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {unlimited ? null : (
                <DropdownMenuItem onSelect={onReset}>
                  <RotateCcw />
                  <span>Reset usage</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onCustomLimit}>
                <SlidersHorizontal />
                <span>
                  {row.source === "custom"
                    ? "Change custom limit"
                    : "Set custom limit"}
                </span>
              </DropdownMenuItem>
              {row.source === "custom" ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={onRemoveCustomLimit}
                  >
                    <Undo2 />
                    <span>Remove custom limit</span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Where this user's limit comes from, as plain text: "Custom", "Default",
 * "No limit", or the environment whose override applies. Hover explains it.
 */
function LimitSource({
  row,
  showEnvironment,
}: {
  row: UserLimitUsage;
  showEnvironment: boolean;
}) {
  const environment = showEnvironment ? row.environmentName : null;
  const { label, hint } =
    row.source === "custom"
      ? { label: "Custom", hint: "A limit set just for this user" }
      : row.source === "environment_default"
        ? {
            label: environment ?? "Environment",
            hint: `The ${row.environmentName ?? "environment"} override applies`,
          }
        : row.source === "organization_default"
          ? { label: "Default", hint: "The organization default applies" }
          : {
              label: "No limit",
              hint: "No default or custom limit covers this user",
            };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1">
          {row.source === "environment_default" ? (
            <Boxes aria-hidden className="size-3" />
          ) : row.source === "custom" ? (
            <SlidersHorizontal aria-hidden className="size-3" />
          ) : null}
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between gap-4">
          <div className="h-3.5 w-48 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-16 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-1 w-full animate-pulse rounded-full bg-muted" />
      </div>
    </div>
  );
}
