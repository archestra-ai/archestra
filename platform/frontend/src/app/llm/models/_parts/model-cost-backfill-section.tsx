"use client";

import {
  addDays,
  differenceInCalendarDays,
  format,
  startOfDay,
} from "date-fns";
import { ArrowRight, Info, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Progress } from "@/components/ui/progress";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  isBackfillActive,
  type ModelCostBackfill,
  type ModelCostBackfillPreview,
  type ModelCostBackfillPrices,
  useModelCostBackfill,
  useModelCostBackfillPreview,
  useStartModelCostBackfill,
} from "@/lib/model-cost-backfill.query";
import { cn } from "@/lib/utils/tailwind";
import { type ChartDay, CostChart, presetDate } from "./model-cost-chart";
import { formatModelCost, formatUsdShort } from "./model-cost-format";

/**
 * "Apply new prices to" on the Pricing page: recompute the recorded cost of
 * past requests with the prices above, from a chosen start. The dialog's Save
 * calls the function this registers, after the prices themselves are saved,
 * so the backfill runs at exactly the prices that were stored.
 */
export function ModelCostBackfillSection({
  modelId,
  prices,
  pricesChanged,
  visible,
  registerStart,
  onDirtyChange,
}: {
  modelId: string;
  /** The form's custom prices; null when a field is invalid. */
  prices: ModelCostBackfillPrices | null;
  pricesChanged: boolean;
  /** Only query while the Pricing page is showing. */
  visible: boolean;
  /** Receives the start function, or null on unmount. Resolves false on failure. */
  registerStart: (start: (() => Promise<boolean>) | null) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const ids = useId();
  const [mode, setMode] = useState<ApplyMode>("new");
  const [sinceDate, setSinceDate] = useState<Date>(() =>
    presetDate(DEFAULT_PRESET_MS),
  );
  const [presetId, setPresetId] = useState<string | null>(DEFAULT_PRESET_ID);

  // Keyed by value (the caller rebuilds the object every render). While a
  // price is invalid the query pauses and the last answer stays on screen.
  const pricesKey = prices ? JSON.stringify(prices) : null;
  const debouncedPricesKey = useDebouncedValue(pricesKey, INPUT_DEBOUNCE_MS);
  const queryPrices = useMemo<ModelCostBackfillPrices | null>(
    () => (debouncedPricesKey ? JSON.parse(debouncedPricesKey) : null),
    [debouncedPricesKey],
  );

  // Dragging the start crosses a bar per pointer move; query where it settles.
  const debouncedSinceMs = useDebouncedValue(
    sinceDate.getTime(),
    INPUT_DEBOUNCE_MS,
  );
  const querySince = useMemo(
    () => new Date(debouncedSinceMs),
    [debouncedSinceMs],
  );

  const latest = useModelCostBackfill({ modelId, enabled: visible });
  const running = isBackfillActive(latest.data);
  const preview = useModelCostBackfillPreview({
    modelId,
    prices: queryPrices ?? EMPTY_PRICES,
    since: querySince,
    enabled: visible && queryPrices !== null,
  });
  const allPreview = useModelCostBackfillPreview({
    modelId,
    prices: queryPrices ?? EMPTY_PRICES,
    since: ALL_HISTORY,
    enabled: visible && queryPrices !== null,
  });
  const start = useStartModelCostBackfill();

  // Each range is checked on its own: per-key prices may need a cache price
  // for the whole history but not for a recent window.
  const sinceData = preview.data ?? null;
  const allData = allPreview.data ?? null;
  const days = allData?.days.length ? allData.days : (sinceData?.days ?? []);
  const hasHistory = days.length > 0;
  const sinceOpen =
    !running && hasHistory && sinceData?.availability === "available";
  const allOpen =
    !running && hasHistory && allData?.availability === "available";
  const effectiveMode: ApplyMode =
    (mode === "since" && !sinceOpen) || (mode === "all" && !allOpen)
      ? "new"
      : mode;
  const activePreview = effectiveMode === "all" ? allPreview : preview;
  const impact = effectiveMode === "new" ? null : activePreview.data?.window;
  const firstRequestDay = hasHistory ? parseDay(days[0].day) : null;
  const blocker = [sinceData, allData].find(
    (data) => data && data.availability !== "available",
  )?.availability;
  const instancePriced =
    sinceData?.instancePriced ?? allData?.instancePriced ?? false;

  useEffect(() => {
    onDirtyChange(effectiveMode !== "new");
  }, [effectiveMode, onDirtyChange]);

  useEffect(() => {
    registerStart(async () => {
      if (effectiveMode === "new") return true;
      const started = await start.mutateAsync({
        modelId,
        since: effectiveMode === "since" ? sinceDate : null,
        // Refused when another edit changed the prices after this save.
        prices: pricesKey ? JSON.parse(pricesKey) : undefined,
      });
      return started !== null;
    });
    return () => registerStart(null);
  }, [
    effectiveMode,
    modelId,
    pricesKey,
    registerStart,
    sinceDate,
    start.mutateAsync,
  ]);

  const pickSince = (date: Date, preset: string | null = null) => {
    setPresetId(preset);
    setSinceDate(new Date(Math.min(date.getTime(), Date.now())));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Apply new prices to</h3>
        <p className="text-xs text-muted-foreground">
          Pick past requests to recompute with the prices above. Runs when you
          save.
        </p>
      </div>

      {latest.data && <LatestBackfill backfill={latest.data} />}
      {!running && (blocker || instancePriced) && (
        <AvailabilityNotice
          availability={blocker ?? "available"}
          instancePriced={instancePriced}
        />
      )}

      {effectiveMode !== "new" && (
        <StatStrip impact={impact ?? null} loading={activePreview.isFetching} />
      )}

      <RadioGroup
        value={effectiveMode}
        onValueChange={(value) => {
          if (isApplyMode(value)) setMode(value);
        }}
        className="gap-2"
      >
        <OptionCard
          id={`${ids}-new`}
          value="new"
          title="New requests only"
          description="Past requests keep the cost they were recorded with."
          figure={
            <span className="block text-xs text-muted-foreground">
              Going forward
            </span>
          }
        />
        <OptionCard
          id={`${ids}-since`}
          value="since"
          disabled={!sinceOpen}
          title="Requests since a date"
          description={`From ${format(sinceDate, "MMM d, yyyy, h:mm a")} onward.`}
          figure={
            <CountFigure
              count={sinceData?.window?.requests ?? null}
              loading={preview.isFetching}
              selected={effectiveMode === "since"}
            />
          }
        >
          {effectiveMode === "since" && firstRequestDay && (
            <CostChart
              days={toChartDays(days)}
              since={sinceDate}
              firstRequestAt={firstRequestDay}
              presetId={presetId}
              onPick={pickSince}
            />
          )}
        </OptionCard>
        <OptionCard
          id={`${ids}-all`}
          value="all"
          disabled={!allOpen}
          title="All recorded requests"
          description={
            firstRequestDay
              ? `Back to the first one, ${format(firstRequestDay, "MMM d, yyyy")}.`
              : "No requests are recorded for this model yet."
          }
          figure={
            <CountFigure
              count={allData?.window?.requests ?? null}
              loading={allPreview.isFetching}
              selected={effectiveMode === "all"}
            />
          }
        />
      </RadioGroup>

      {impact && impact.requests > 0 && (
        <Footnote impact={impact} pricesChanged={pricesChanged} />
      )}
    </div>
  );
}

// ===

type ApplyMode = "new" | "since" | "all";
type PreviewWindow = NonNullable<ModelCostBackfillPreview["window"]>;
type Availability = ModelCostBackfillPreview["availability"];

const DEFAULT_PRESET_ID = "30d";
const DEFAULT_PRESET_MS = 30 * 24 * 3600_000;
const INPUT_DEBOUNCE_MS = 300;
/** Earlier than any recorded request: "everything". Stable for query keys. */
const ALL_HISTORY = new Date(0);
const EMPTY_PRICES: ModelCostBackfillPrices = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

function isApplyMode(value: string): value is ApplyMode {
  return value === "new" || value === "since" || value === "all";
}

/** "YYYY-MM-DD" from the server, in the browser's time zone, as local midnight. */
function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** Every calendar day from the first request to today, empty days included. */
function toChartDays(days: ModelCostBackfillPreview["days"]): ChartDay[] {
  if (days.length === 0) return [];
  const byDay = new Map(days.map((day) => [day.day, day]));
  const first = parseDay(days[0].day);
  const total = differenceInCalendarDays(startOfDay(new Date()), first) + 1;
  return Array.from({ length: Math.max(total, 1) }, (_, offset) => {
    const date = addDays(first, offset);
    const day = byDay.get(format(date, "yyyy-MM-dd"));
    return {
      day: date,
      requests: day?.requests ?? 0,
      recordedCost: day?.recordedCost ?? 0,
      recomputedCost: day?.recomputedCost ?? 0,
    };
  });
}

function OptionCard({
  id,
  value,
  title,
  description,
  figure,
  children,
  disabled = false,
}: {
  id: string;
  value: ApplyMode;
  title: string;
  description: string;
  figure: ReactNode;
  /** Full card width, under the header row. */
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cn(radioCardClass(), "rounded-lg")}>
      <label
        htmlFor={id}
        className={cn(
          "flex items-center gap-3 p-3",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <RadioGroupItem id={id} value={value} disabled={disabled} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        <span className="shrink-0 pl-2 text-right">{figure}</span>
      </label>
      {children ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

function CountFigure({
  count,
  loading,
  selected,
}: {
  count: number | null;
  loading: boolean;
  selected: boolean;
}) {
  return (
    <span className={cn("block transition-opacity", loading && "opacity-50")}>
      <span
        className={cn(
          "block text-sm leading-tight tabular-nums",
          selected ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {count === null ? "-" : count.toLocaleString("en-US")}
      </span>
      <span className="block text-xs leading-tight text-muted-foreground">
        {count === 1 ? "request" : "requests"}
      </span>
    </span>
  );
}

/** One-row impact strip: Requests · Cost recorded → recomputed · Users affected. */
function StatStrip({
  impact,
  loading,
}: {
  impact: PreviewWindow | null;
  loading: boolean;
}) {
  if (!impact) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <span>Loading what will change…</span>
      </p>
    );
  }
  if (impact.requests === 0 && !loading) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        No requests were recorded for this model in that range.
      </p>
    );
  }

  const delta = impact.recomputedCost - impact.recordedCost;
  const deltaLabel = `${delta >= 0 ? "+" : "-"}${formatUsdShort(Math.abs(delta))}`;
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] divide-x rounded-lg border bg-muted/40 transition-opacity",
        loading && "opacity-60",
      )}
      aria-busy={loading}
      aria-live="polite"
    >
      <Stat label="Requests">
        <span className="flex items-center gap-1.5 text-base font-semibold">
          <span>{impact.requests.toLocaleString("en-US")}</span>
          {loading && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
        </span>
      </Stat>
      <Stat
        label={
          <>
            <span>Cost</span>
            <span className="hidden text-muted-foreground/80 min-[420px]:inline">
              {` · ${deltaLabel}`}
            </span>
          </>
        }
      >
        <span
          className="flex min-w-0 items-center gap-1 text-sm"
          title={`${formatModelCost(impact.recordedCost)} recorded, ${formatModelCost(impact.recomputedCost)} with the prices above (${deltaLabel})`}
        >
          <span className="truncate text-muted-foreground">
            {formatUsdShort(impact.recordedCost)}
          </span>
          <ArrowRight
            aria-label="to"
            className="size-3 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-medium">
            {formatUsdShort(impact.recomputedCost)}
          </span>
        </span>
      </Stat>
      <Stat label="Users affected" alignEnd>
        <span className="text-sm font-medium">
          {impact.users.toLocaleString("en-US")}
        </span>
      </Stat>
    </div>
  );
}

function Stat({
  label,
  children,
  alignEnd,
}: {
  label: ReactNode;
  children: ReactNode;
  alignEnd?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-center px-3 py-1.5",
        alignEnd && "items-end text-right",
      )}
    >
      <span className="truncate text-[11px] leading-4 text-muted-foreground">
        {label}
      </span>
      <span className="leading-6 tabular-nums">{children}</span>
    </div>
  );
}

function Footnote({
  impact,
  pricesChanged,
}: {
  impact: PreviewWindow;
  pricesChanged: boolean;
}) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>
        {pricesChanged ? null : (
          <span>Prices are unchanged, so current prices are used. </span>
        )}
        <span>
          Saving overwrites stored costs; statistics and cost limits follow.
        </span>
        {impact.subscriptionRequests > 0 ? (
          <span>
            {" "}
            <span className="tabular-nums">
              {impact.subscriptionRequests.toLocaleString("en-US")}
            </span>{" "}
            subscription requests keep $0 billed spend.
          </span>
        ) : null}
      </span>
    </p>
  );
}

function AvailabilityNotice({
  availability,
  instancePriced,
}: {
  availability: Availability;
  instancePriced: boolean;
}) {
  if (availability === "available" && !instancePriced) return null;
  const notice = noticeFor(availability);
  return (
    <InlineNotice variant="info">
      <Info />
      <InlineNoticeBody>
        <span className="font-medium">{notice.title}</span>
        <InlineNoticeText>{notice.text}</InlineNoticeText>
      </InlineNoticeBody>
    </InlineNotice>
  );
}

function noticeFor(availability: Availability): {
  title: string;
  text: string;
} {
  switch (availability) {
    case "available":
      // Only reached for per-key (LiteLLM) prices once a custom price is set.
      return {
        title: "Past requests will use the price above",
        text: "Your LiteLLM gateway prices this model per API key, and past requests don't record which key they used, so every recomputed request uses the price above.",
      };
    case "needs_custom_price":
      return {
        title: "Enter this model's price to recompute past requests",
        text: "Your LiteLLM gateway prices this model per API key, and past requests don't record which key they used. Set the input and output price above, then pick a range.",
      };
    case "provider_reported_cost":
      return {
        title: "Past requests keep their recorded cost",
        text: "OpenRouter reports what many requests actually cost, and past requests don't record which ones it reported. Recomputing them would replace real charges with estimates, so new prices apply to new requests only.",
      };
    case "index_pending":
      return {
        title: "Recomputing past requests is getting ready",
        text: "The database is still building what it needs to do this quickly, which takes a few minutes after an upgrade. New prices apply to new requests right away.",
      };
  }
}

/** The latest recompute: progress while it runs, its outcome afterwards. */
function LatestBackfill({ backfill }: { backfill: ModelCostBackfill }) {
  if (isBackfillActive(backfill)) {
    const percent =
      backfill.rowsEstimated > 0
        ? Math.min(100, (backfill.rowsScanned / backfill.rowsEstimated) * 100)
        : 0;
    return (
      <div className="space-y-2 rounded-lg border bg-muted/40 px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="font-medium">Recomputing past costs</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {`${backfill.rowsScanned.toLocaleString("en-US")} of ${backfill.rowsEstimated.toLocaleString("en-US")}`}
          </span>
        </div>
        <Progress value={percent} aria-label="Recompute progress" />
      </div>
    );
  }
  if (backfill.status === "failed") {
    return (
      <InlineNotice variant="error">
        <Info />
        <InlineNoticeBody>
          <span className="font-medium">The last recompute stopped</span>
          <InlineNoticeText>
            {`${backfill.rowsUpdated.toLocaleString("en-US")} requests were updated before it stopped. Pick a range and save to run it again.`}
          </InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {`Last recomputed ${format(new Date(backfill.completedAt ?? backfill.createdAt), "MMM d, yyyy, h:mm a")}: ${backfill.rowsUpdated.toLocaleString("en-US")} requests changed.`}
    </p>
  );
}
