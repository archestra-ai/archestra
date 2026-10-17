"use client";

import type { SupportedProvider } from "@archestra/shared";
import { GitBranch, GitFork, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  describeModelOrigin,
  formatCompactNumber,
  formatUsageCost,
  type LogSession,
  shortModelName,
  sourceLabel,
  uniqueSources,
} from "@/app/llm/logs/_parts/logs-table-format";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { CopyButton } from "@/components/copy-button";
import { formatCost } from "@/components/cost";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { SourceIcon } from "@/components/source-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import type { InteractionSummary } from "./session-timeline";

export type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: string | null | undefined;
  billedCost: string | null | undefined;
  subscriptionCost: string | null | undefined;
  baselineCost: string | null | undefined;
};

export type SessionLineage = {
  forkedFrom: string | null;
  forks: string[];
  forksTruncated: boolean;
};

/** Started, Requests, Tokens, Cost and Models as one hairline strip. */
export function SessionFacts({
  totals,
  totalRequests,
  rows,
  models,
  firstRequest,
  lastRequest,
  fallbackType,
  providerLabel,
}: {
  totals: SessionTotals;
  totalRequests: number;
  /** The requests on this page, for latency figures. */
  rows: InteractionSummary[];
  models: string[];
  firstRequest: string | null;
  lastRequest: string | null;
  /** The newest request's type, which names an aggregator for unknown ids. */
  fallbackType: string | null;
  /** The organization's name for a provider. */
  providerLabel: (provider: SupportedProvider) => string;
}) {
  const cost = Number(totals.cost ?? 0);
  const subscription = Number(totals.subscriptionCost ?? 0);
  // A subscription-only aggregate has no metered rows, so its billed sum is
  // null; anything else without a billed sum predates the column.
  const billed =
    totals.billedCost != null
      ? Number(totals.billedCost)
      : subscription > 0
        ? 0
        : cost;
  const baseline = Number(totals.baselineCost ?? totals.cost ?? 0);
  const saved = Math.max(0, baseline - cost);
  const onPlanOnly = subscription > 0 && billed === 0;
  const tokens = totals.inputTokens + totals.outputTokens;
  const cached = totals.cacheReadTokens + totals.cacheWriteTokens;

  const wallClock =
    firstRequest && lastRequest
      ? new Date(lastRequest).getTime() - new Date(firstRequest).getTime()
      : null;

  const durations = rows
    .map((row) => row.durationMs)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);
  const averageMs =
    durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : null;
  const medianMs =
    durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null;
  const slowestMs =
    durations.length > 0 ? durations[durations.length - 1] : null;

  const modelEntries = models.map((id) => {
    const origin = describeModelOrigin({
      model: id,
      interactionType: fallbackType,
    });
    return {
      id,
      name: shortModelName(id),
      provider: origin.kind === "unknown" ? null : origin.provider,
      vendor:
        origin.kind === "aggregator"
          ? providerLabel(origin.provider)
          : origin.name,
    };
  });
  const shownModels = modelEntries.slice(0, 3);
  const hiddenModels = modelEntries.slice(3);

  return (
    <FactsStrip label="Session facts">
      <Fact label="Started">
        {firstRequest ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <UnstyledButton className="block cursor-default text-left">
                <FactValue>
                  {formatDate({
                    date: firstRequest,
                    dateFormat: "MMM d, HH:mm",
                  })}
                </FactValue>
                <FactSub>
                  {wallClock != null && wallClock > 0
                    ? `ran ${formatElapsed(wallClock)}`
                    : "single request"}
                </FactSub>
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent className="px-2 py-1.5">
              <TooltipFigures
                rows={[
                  ["First request", formatDate({ date: firstRequest })],
                  ...(lastRequest
                    ? [
                        [
                          "Last request",
                          formatDate({ date: lastRequest }),
                        ] as const,
                      ]
                    : []),
                ]}
              />
            </TooltipContent>
          </Tooltip>
        ) : (
          <FactValue muted>—</FactValue>
        )}
      </Fact>

      <Fact label="Requests">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block cursor-default text-left">
              <FactValue>{totalRequests.toLocaleString()}</FactValue>
              <FactSub>
                {averageMs != null
                  ? `${formatLatency(Math.round(averageMs))} avg latency`
                  : "no timings"}
              </FactSub>
            </UnstyledButton>
          </TooltipTrigger>
          {medianMs != null && slowestMs != null ? (
            <TooltipContent className="px-2 py-1.5">
              <TooltipFigures
                rows={[
                  ["Median", formatLatency(medianMs)],
                  ["Slowest", formatLatency(slowestMs)],
                ]}
              />
              <p className="pt-1 text-[11px] text-muted-foreground">
                Across the {durations.length} timed requests on this page
              </p>
            </TooltipContent>
          ) : null}
        </Tooltip>
      </Fact>

      <Fact label="Tokens">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block cursor-default text-left">
              <FactValue>
                <span>{formatCompactNumber(tokens)}</span>
                {cached > 0 ? (
                  <CacheMeter
                    read={totals.cacheReadTokens}
                    write={totals.cacheWriteTokens}
                  />
                ) : null}
              </FactValue>
              <FactSub>
                {formatCompactNumber(totals.inputTokens)} in ·{" "}
                {formatCompactNumber(totals.outputTokens)} out
              </FactSub>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1.5">
            <TooltipFigures
              rows={[
                ["Input", totals.inputTokens.toLocaleString()],
                ["Output", totals.outputTokens.toLocaleString()],
                ["Cache read", totals.cacheReadTokens.toLocaleString()],
                ["Cache write", totals.cacheWriteTokens.toLocaleString()],
              ]}
            />
          </TooltipContent>
        </Tooltip>
      </Fact>

      <Fact label="Cost">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block cursor-default text-left">
              <FactValue muted={onPlanOnly}>
                {subscription > 0 ? <PlanTag /> : null}
                <span>
                  {totals.cost == null
                    ? "—"
                    : formatUsageCost(onPlanOnly ? subscription : billed)}
                </span>
              </FactValue>
              <FactSub>
                {onPlanOnly
                  ? "list price · not billed"
                  : subscription > 0
                    ? `+ ${formatUsageCost(subscription)} on plan`
                    : saved > 0
                      ? `saved ${formatUsageCost(saved)}`
                      : "metered"}
              </FactSub>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1.5">
            <TooltipFigures
              rows={[
                ["Billed", formatCost(billed)],
                ...(subscription > 0
                  ? [
                      [
                        "Subscription (list, not billed)",
                        formatCost(subscription),
                      ] as const,
                    ]
                  : []),
                ["List price", formatCost(cost)],
                ...(saved > 0
                  ? [["Saved by optimization", formatCost(saved)] as const]
                  : []),
              ]}
            />
          </TooltipContent>
        </Tooltip>
      </Fact>

      <Fact
        label={modelEntries.length === 1 ? "Model" : "Models"}
        className="col-span-2 max-lg:border-b-0 lg:flex-[2_1_260px]"
      >
        {modelEntries.length === 0 ? (
          <FactValue muted>—</FactValue>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-0.5 lg:flex lg:flex-wrap lg:items-center lg:gap-x-3.5 lg:gap-y-1.5">
            {shownModels.map((model) => (
              <li key={model.id} className="max-lg:min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <UnstyledButton className="flex cursor-default items-center gap-1.5 text-left lg:inline-flex">
                      <MakerDisc
                        provider={model.provider}
                        vendor={model.vendor}
                        ring={false}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm leading-4 font-medium max-lg:truncate">
                          {model.name}
                        </span>
                        <span className="block text-[11px] leading-4 text-muted-foreground max-lg:truncate">
                          {model.vendor}
                        </span>
                      </span>
                    </UnstyledButton>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-[11px]">
                    {model.id}
                  </TooltipContent>
                </Tooltip>
              </li>
            ))}
            {hiddenModels.length > 0 ? (
              <li className="max-lg:self-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <UnstyledButton
                      aria-label={`${hiddenModels.length} more models`}
                      className="cursor-default rounded-sm px-1 text-xs leading-5 text-muted-foreground tabular-nums ring-1 ring-border ring-inset hover:text-foreground"
                    >
                      +{hiddenModels.length}
                    </UnstyledButton>
                  </TooltipTrigger>
                  <TooltipContent className="px-2 py-1.5">
                    <ul className="space-y-1">
                      {hiddenModels.map((model) => (
                        <li key={model.id} className="flex items-center gap-2">
                          <MakerDisc
                            provider={model.provider}
                            vendor={model.vendor}
                            size={18}
                            ring={false}
                          />
                          <span className="font-medium">{model.name}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {model.id}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              </li>
            ) : null}
          </ul>
        )}
      </Fact>
    </FactsStrip>
  );
}

/**
 * The trajectory identity OpenAPPA bound: the session id, what bound it,
 * each origin that wrote to it, and the sessions it forked from or into.
 */
export function TrajectoryFacts({
  session,
  lineage,
}: {
  session: LogSession | undefined;
  lineage: SessionLineage | undefined;
}) {
  if (!session) return null;
  const origins = uniqueSources(session);
  if (origins.length === 0 && session.source) origins.push(session.source);
  const forks = lineage?.forks ?? [];
  const hasLineage = Boolean(lineage?.forkedFrom) || forks.length > 0;
  if (
    !session.sessionId &&
    !session.sessionSource &&
    origins.length === 0 &&
    !hasLineage
  ) {
    return null;
  }

  return (
    <section
      aria-label="Trajectory"
      className="flex flex-col gap-3 rounded-lg border border-dashed px-4 py-3 text-xs lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6 lg:gap-y-2 lg:py-2.5"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>Trajectory</span>
      </span>
      {session.sessionId ? (
        <TrajectoryFact label="Session">
          <span className="min-w-0 font-mono break-all max-lg:py-1 max-lg:text-[11px] max-lg:leading-5">
            {session.sessionId}
          </span>
          <CopyButton
            text={session.sessionId}
            size={12}
            className="relative after:absolute after:-inset-1 after:content-[''] lg:after:hidden"
          />
        </TrajectoryFact>
      ) : null}
      {session.sessionSource ? (
        <TrajectoryFact label="Bound by">
          <span className="font-mono">{session.sessionSource}</span>
        </TrajectoryFact>
      ) : null}
      {origins.length > 0 ? (
        <TrajectoryFact label={origins.length === 1 ? "Origin" : "Origins"}>
          <span className="flex flex-wrap gap-1">
            {origins.map((origin) => (
              <span
                key={origin}
                className="inline-flex h-5 items-center gap-1 rounded-sm bg-muted px-1.5 [&_svg]:size-3"
              >
                <SourceIcon source={origin} />
                <span>{sourceLabel(origin)}</span>
              </span>
            ))}
          </span>
        </TrajectoryFact>
      ) : null}
      {lineage?.forkedFrom ? (
        <TrajectoryFact
          label="Forked from"
          icon={<GitBranch className="size-3" aria-hidden="true" />}
        >
          <SessionLink sessionId={lineage.forkedFrom} />
        </TrajectoryFact>
      ) : null}
      {forks.length > 0 ? (
        <TrajectoryFact
          label={forks.length === 1 ? "Fork" : "Forks"}
          icon={<GitFork className="size-3" aria-hidden="true" />}
        >
          <span className="flex flex-col gap-0.5">
            {forks.map((fork) => (
              <SessionLink key={fork} sessionId={fork} />
            ))}
            {lineage?.forksTruncated ? (
              <span className="text-muted-foreground">
                Additional forks not shown
              </span>
            ) : null}
          </span>
        </TrajectoryFact>
      ) : null}
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function TooltipFigures({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CacheMeter({ read, write }: { read: number; write: number }) {
  const total = read + write;
  const readPct = total > 0 ? (read / total) * 100 : 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-normal tracking-normal whitespace-nowrap text-muted-foreground">
      <span
        aria-hidden="true"
        className="flex h-1 w-10 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="bg-sky-500/80 dark:bg-sky-400/80"
          style={{ width: `${readPct}%` }}
        />
        <span
          className="bg-sky-500/30 dark:bg-sky-400/30"
          style={{ width: `${100 - readPct}%` }}
        />
      </span>
      <span>{formatCompactNumber(total)} cached</span>
    </span>
  );
}

function PlanTag() {
  return (
    <span className="rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
      Plan
    </span>
  );
}

function TrajectoryFact({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  // Phones put the label above the value, so long ids and chip lists get the
  // full width.
  return (
    <span className="flex min-w-0 flex-col gap-1 lg:inline-flex lg:flex-row lg:items-center lg:gap-2">
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {icon}
        <span>{label}</span>
      </span>
      <span className="flex min-w-0 items-start gap-1 text-foreground lg:inline-flex lg:items-center">
        {children}
      </span>
    </span>
  );
}

/** A link to another session's page, by its id. */
function SessionLink({ sessionId }: { sessionId: string }) {
  return (
    <Link
      href={`/llm/logs/session/${encodeURIComponent(sessionId)}`}
      className="font-mono break-all underline-offset-2 hover:underline"
    >
      {sessionId}
    </Link>
  );
}
