"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDate } from "@/lib/utils/date-time";
import type { ValidationRunBar } from "./validation-run-history";

/** Status colors, matching ValidationStatusBadge. */
const SEGMENTS = [
  { key: "passed", label: "Passed", className: "bg-green-500" },
  { key: "failed", label: "Failed", className: "bg-red-500" },
  { key: "cannotRun", label: "Cannot run", className: "bg-yellow-500" },
] as const;

/** Bar heights for the empty chart: a shape, not data. */
const PLACEHOLDER = [45, 70, 55, 85, 65, 40, 75, 60];

const PLOT = "flex h-24 items-end justify-center gap-2 border-b border-border";
const COLUMN = "flex h-full max-w-[18px] flex-1 items-end";

/** Recent runs as stacked columns, oldest left, one tooltip per run. */
export function ValidationRunChart({ bars }: { bars: ValidationRunBar[] }) {
  const max = Math.max(...bars.map((bar) => bar.total), 1);
  return (
    <figure className="space-y-3">
      <div
        role="img"
        aria-label={`Validation results over the last ${bars.length} ${bars.length === 1 ? "run" : "runs"}`}
        className={PLOT}
      >
        {bars.map((bar) => (
          <Tooltip key={bar.id}>
            <TooltipTrigger asChild>
              {/* The whole column is the hover target, not just its fill. */}
              <div className={COLUMN}>
                <div
                  className="flex w-full flex-col-reverse gap-0.5 overflow-hidden rounded-t-sm"
                  style={{ height: `${(bar.total / max) * 100}%` }}
                >
                  {SEGMENTS.map(({ key, className }) =>
                    bar[key] > 0 ? (
                      <div
                        key={key}
                        className={className}
                        style={{ flexGrow: bar[key] }}
                      />
                    ) : null,
                  )}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="mb-1 font-medium">
                {formatDate({ date: bar.createdAt })}
              </p>
              <dl className="space-y-1">
                {SEGMENTS.filter(({ key }) => bar[key] > 0).map(
                  ({ key, label, className }) => (
                    <div key={key} className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`size-2 shrink-0 rounded-full ${className}`}
                      />
                      <dt>{label}</dt>
                      <dd className="ml-auto pl-3 tabular-nums">{bar[key]}</dd>
                    </div>
                  ),
                )}
              </dl>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <figcaption className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {SEGMENTS.map(({ key, label, className }) => (
          <span key={key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${className}`}
            />
            <span>{label}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** The chart's shape in gray, with a title and line beneath it, before any run counts. */
export function ValidationRunChartPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <figure className="space-y-3">
      <div aria-hidden className={PLOT}>
        {PLACEHOLDER.map((height, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decorative shape
          <div key={index} className={COLUMN}>
            <div
              className="w-full rounded-t-sm bg-muted"
              style={{ height: `${height}%` }}
            />
          </div>
        ))}
      </div>
      <figcaption className="space-y-0.5 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </figcaption>
    </figure>
  );
}
