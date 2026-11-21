"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  FilterBar,
  filterSearchClass,
  useCompactFilters,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type LogEvent,
  type LogEventsQuery,
  type LogEventsPage,
  type LogSource,
  type LogStats,
  type LogStatus,
  SOURCES,
  useLogEvents,
  useLogStats,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";
import { DayHeader, LogRow, SkeletonRows, sameDay } from "./log-row";
import { PROBLEM_STATUSES, TypeFilters } from "./type-filters";
import { ProblemsSwitch, TypeTiles } from "./type-tiles";

export function LogsPage() {
  const url = useUrlState();
  const { type, hours, get } = url;

  // ----- search: local while typing, URL after a pause -----
  const q = get("q") ?? "";
  const [search, setSearch] = useState(q);
  const setRef = useRef(url.set);
  setRef.current = url.set;
  useEffect(() => {
    if (search.trim() === q) return;
    const t = setTimeout(() => setRef.current({ q: search.trim() }), 250);
    return () => clearTimeout(t);
  }, [search, q]);

  // ----- the query, derived from the URL alone -----
  const filters = buildQuery({ type, hours, get });
  const filterKey = JSON.stringify(filters);

  // ----- tiles: per-type counts that ignore the type and its filters -----
  const tiles = useLogStats({ q: q || undefined, hours });
  const tileProblems = useLogStats({
    q: q || undefined,
    hours,
    statuses: PROBLEM_STATUSES,
  });
  const bySource = (f?: LogStats["facets"]) =>
    Object.fromEntries(
      SOURCES.map((s) => [
        s.id,
        f?.source.find((x) => x.value === s.id)?.count ?? 0,
      ]),
    ) as Record<LogSource, number>;

  // ----- infinite scroll: first page + accumulated cursor pages -----
  const first = useLogEvents(filters);
  const [extra, setExtra] = useState<ExtraPages>(EMPTY_EXTRA);
  const active = extra.key === filterKey ? extra : EMPTY_EXTRA;
  const pages: LogEventsPage[] = [];
  if (first.data) {
    pages.push(first.data);
    for (const c of active.cursors) {
      const page = active.loaded[c];
      if (!page) break;
      pages.push(page);
    }
  }
  const rows = pages.flatMap((p) => p.data);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;
  const loadingMore = active.cursors.some((c) => !active.loaded[c]);
  const stale = first.isPlaceholderData;
  const canLoadMore = !!nextCursor && !loadingMore && !stale;

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoadMore || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setExtra((s) => {
          const base =
            s.key === filterKey ? s : { ...EMPTY_EXTRA, key: filterKey };
          if (base.cursors.includes(nextCursor)) return s;
          return { ...base, cursors: [...base.cursors, nextCursor] };
        });
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoadMore, nextCursor, filterKey]);

  // ----- sticky toolbar height, for the day headers under it -----
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarH, setToolbarH] = useState(0);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setToolbarH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // PageLayout's header sticks from md up; the toolbar and day headers stick
  // under it.
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-page-header]");
    if (!el) return;
    const measure = () =>
      setHeaderH(
        getComputedStyle(el).position === "sticky" ? el.offsetHeight : 0,
      );
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const days = groupByDay(rows);
  const stats = useLogStats(filters);
  const facets = stats.data?.facets;
  const total = stats.data?.total ?? 0;
  const hasFilters = !!type || !!q || PER_TYPE_KEYS.some((k) => !!get(k));

  const compact = useCompactFilters();
  const perTypeActive = PER_TYPE_KEYS.some((k) => !!get(k));
  const typeFilters = (
    <TypeFilters
      type={type}
      facets={facets}
      filters={filters}
      get={get}
      set={url.set}
    />
  );

  const clearAll = () => {
    setSearch("");
    url.set({ type: undefined, q: undefined, ...CLEARED });
  };

  const problemsOn = get("status") === "problems";
  const problemCount = facets?.status
    .filter((f) => PROBLEM_STATUSES.includes(f.value as LogStatus))
    .reduce((n, f) => n + f.count, 0);
  const problemsSwitch = (
    <ProblemsSwitch
      on={problemsOn}
      count={problemCount}
      compact={compact}
      onChange={(on) => url.set({ status: on ? "problems" : undefined })}
    />
  );

  return (
    <PageLayout title="Logs" description={DESCRIPTION}>
      <div className="@container min-w-0">
        {/* ----- type tiles: overview and type switcher ----- */}
        <TypeTiles
          type={type}
          counts={bySource(tiles.data?.facets)}
          problems={bySource(tileProblems.data?.facets)}
          buckets={tiles.data?.buckets}
          problemBuckets={tileProblems.data?.buckets}
          loading={tiles.isPending}
          onPick={(t, opts) =>
            url.set({
              type: t,
              ...CLEARED,
              status: opts?.problems ? "problems" : undefined,
            })
          }
        />

        {/* ----- the one toolbar ----- */}
        <div
          ref={toolbarRef}
          style={{ top: headerH }}
          className={cn(
            "sticky z-10 -mx-4 mt-1 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6",
            // One row: the type picker rides FilterBar's search slot, so on
            // desktop it is the row's first flex item and anything that wraps
            // starts at the left edge. Below lg: picker + search (filling the
            // row) + funnel, all 36px.
            "max-lg:[&_[data-slot=filter-controls]>div:first-child]:flex! max-lg:[&_[data-slot=filter-controls]>div:first-child]:max-w-none! max-lg:[&_[data-slot=filter-controls]>div:first-child]:gap-1.5",
            "max-lg:[&_[data-slot=input]]:h-9! max-lg:[&_button[aria-label^=Filters]]:size-9! max-lg:[&_button[aria-label^=Filters]]:min-h-9!",
          )}
        >
          <FilterBar
            search={
              <div
                className={cn(
                  filterSearchClass,
                  "max-lg:max-w-none! max-lg:flex-1 lg:w-[20rem] lg:max-w-[20rem]",
                )}
              >
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={SEARCH_PLACEHOLDER[type ?? "all"]}
                  aria-label="Search"
                  className="h-8 pr-8 pl-8 text-sm"
                />
                {search && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Clear search"
                    className="absolute top-1/2 right-0.5 -translate-y-1/2"
                    onClick={() => setSearch("")}
                  >
                    <X />
                  </Button>
                )}
              </div>
            }
            onClearFilters={
              perTypeActive ? () => url.set({ ...CLEARED }) : undefined
            }
          >
            {compact ? (
              // In the funnel popover each chip spans the popover, like
              // today's stretched triggers.
              <div
                key={type ?? "all"}
                className="flex flex-col gap-2 [&>*]:w-full [&_[data-chip-trigger]]:flex-1 [&_[data-chip-trigger][data-idle]]:justify-between"
              >
                {typeFilters}
                {problemsSwitch}
              </div>
            ) : (
              <Fragment key={type ?? "all"}>
                {typeFilters}
                {problemsSwitch}
              </Fragment>
            )}
          </FilterBar>
        </div>

        {/* ----- the stream ----- */}
        <div className="overflow-clip rounded-lg border bg-background">
          {first.isPending ? (
            <SkeletonRows count={14} />
          ) : first.isError ? (
            <Empty
              title="Logs could not load"
              body="Try again in a moment."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => first.refetch()}
                >
                  Retry
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Empty
              title="No events match"
              body={"Try fewer filters."}
              action={
                hasFilters ? (
                  <Button size="sm" variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : (
            <div
              className={cn(
                "transition-opacity",
                stale && first.isFetching && "opacity-60",
              )}
            >
              {days.map((day) => (
                // Each day is its own section so its header sticks only while
                // that day is on screen.
                <section key={day[0].id}>
                  <DayHeader
                    iso={day[0].timestamp}
                    top={headerH + toolbarH}
                    trailing={
                      day === days[0] ? (
                        <span>{total.toLocaleString()} events</span>
                      ) : undefined
                    }
                  />
                  <div className="divide-y divide-border/60">
                    {day.map((e) => (
                      <LogRow key={e.id} event={e} showSource={!type} />
                    ))}
                  </div>
                </section>
              ))}
              {(loadingMore || (nextCursor && !stale)) && (
                <div ref={sentinel} className="border-t border-border/60">
                  <SkeletonRows count={3} />
                </div>
              )}
              {!nextCursor && !stale && (
                <div className="border-t px-3.5 py-3 text-center text-xs text-muted-foreground">
                  That's everything
                </div>
              )}
            </div>
          )}
        </div>

        {active.cursors
          .filter((c) => !active.loaded[c])
          .map((c) => (
            <PageFetcher
              key={c}
              query={{ ...filters, cursor: c }}
              onLoaded={(data) =>
                setExtra((s) =>
                  s.key === filterKey
                    ? { ...s, loaded: { ...s.loaded, [c]: data } }
                    : s,
                )
              }
            />
          ))}
      </div>
    </PageLayout>
  );
}

// ===== URL state =====

type Getter = (key: string) => string | undefined;
type Setter = (patch: Record<string, string | undefined>) => void;

function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = params.toString();
  const get: Getter = (k) => params.get(k) || undefined;
  const set: Setter = (patch) => {
    // Start from the live params so anything unknown stays.
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const rawType = get("type");
  const type = SOURCES.some((s) => s.id === rawType)
    ? (rawType as LogSource)
    : undefined;
  // No time range control: infinite scroll walks back through the whole
  // history the feed returns.
  const hours = HISTORY_HOURS;
  return { key, get, set, type, hours };
}

const HISTORY_HOURS = 72;

const PER_TYPE_KEYS = [
  "status",
  "agent",
  "actor",
  "client",
  "model",
  "mcpServer",
  "record",
  "decision",
  "connectionAction",
  "auditAction",
  "auditCategory",
  "resourceType",
  "resourceName",
  "actorKind",
  "outcome",
] as const;

const CLEARED = Object.fromEntries(PER_TYPE_KEYS.map((k) => [k, undefined]));

function buildQuery({
  type,
  hours,
  get,
}: {
  type: LogSource | undefined;
  hours: number;
  get: Getter;
}): LogEventsQuery {
  const query: LogEventsQuery = {
    sources: type ? [type] : undefined,
    q: get("q"),
    hours,
    limit: PAGE_SIZE,
  };
  if (get("status") === "problems") query.statuses = PROBLEM_STATUSES;
  if (type === "llm") {
    query.agent = get("agent");
    query.actor = get("actor");
    query.client = get("client");
    query.model = get("model");
  } else if (type === "mcp") {
    query.agent = get("agent");
    query.mcpServer = get("mcpServer");
    query.actor = get("actor");
  } else if (type === "guardrails") {
    const record = get("record");
    const decision = get("decision") as "allow" | "deny" | "review" | undefined;
    if (record === "yell") query.decision = ["yell"];
    else if (decision) query.decision = [decision];
    else if (record === "consult")
      query.decision = ["consult", "allow", "deny", "review"];
  } else if (type === "connections") {
    query.actor = get("actor");
    query.connectionAction = get("connectionAction");
  } else if (type === "audit") {
    query.auditAction = get("auditAction");
    query.auditCategory = get("auditCategory");
    query.actor = get("actor");
    query.actorKind = get("actorKind");
    query.resourceType = get("resourceType");
    query.resourceName = get("resourceName");
    const outcome = get("outcome");
    if (outcome === "success") query.statuses = ["ok"];
    if (outcome === "failure") query.statuses = ["error"];
  }
  return query;
}

// ===== small pieces =====

const PAGE_SIZE = 50;

type ExtraPages = {
  key: string;
  cursors: string[];
  loaded: Record<string, LogEventsPage>;
};
const EMPTY_EXTRA: ExtraPages = { key: "", cursors: [], loaded: {} };

function PageFetcher({
  query,
  onLoaded,
}: {
  query: LogEventsQuery;
  onLoaded: (data: LogEventsPage) => void;
}) {
  const { data, isPlaceholderData } = useLogEvents(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: report each page once
  useEffect(() => {
    if (data && !isPlaceholderData) onLoaded(data);
  }, [data, isPlaceholderData]);
  return null;
}

function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function groupByDay(rows: LogEvent[]) {
  const days: LogEvent[][] = [];
  for (const e of rows) {
    const last = days.at(-1);
    if (last && sameDay(last[0].timestamp, e.timestamp)) last.push(e);
    else days.push([e]);
  }
  return days;
}

const DESCRIPTION =
  "Every request, tool call, guardrail decision, connection and admin change in one place.";

// Only fields the search really matches, so the hint is a promise.
const SEARCH_PLACEHOLDER: Record<LogSource | "all", string> = {
  all: "Search tools, models, people, agents…",
  llm: "Search models, people, session IDs…",
  mcp: "Search tools, servers, people…",
  guardrails: "Search tools, policies, reasons…",
  connections: "Search people, apps, gateways…",
  audit: "Search actions, resources, people…",
};
