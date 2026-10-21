"use client";

import type { SupportedProvider } from "@archestra/shared";
import { GitBranch, GitFork, Sparkles } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
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
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
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

/**
 * Started, Requests, Tokens, Cost and Models as one tight facts card. With
 * OpenAPPA on, the trajectory identity it bound (the session id, what bound
 * it, each origin that wrote to it, and its fork lineage) is a thin second
 * row of the same card.
 */
export function SessionFacts({
  totals,
  totalRequests,
  rows,
  models,
  firstRequest,
  lastRequest,
  fallbackType,
  providerLabel,
  trajectory,
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
  /** Present when OpenAPPA is on; the second row shows only then. */
  trajectory: {
    session: LogSession | undefined;
    lineage: SessionLineage | undefined;
  } | null;
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
  const ran =
    wallClock != null && wallClock > 0 ? formatElapsed(wallClock) : null;

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

  const modelEntries = models.map((id): ModelEntry => {
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
  const identity = trajectory ? readTrajectory(trajectory) : null;

  return (
    <FactsStrip
      label="Session facts"
      footerLabel="Trajectory"
      footer={identity ? <TrajectoryRow t={identity} /> : null}
    >
      <Fact label="Started">
        <FactTip
          tip={
            firstRequest ? (
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
                  ...(ran ? [["Ran for", ran] as const] : []),
                ]}
              />
            ) : null
          }
        >
          <FactValue muted={!firstRequest}>
            {firstRequest
              ? formatDate({ date: firstRequest, dateFormat: "MMM d, HH:mm" })
              : "—"}
          </FactValue>
          <FactSub>{ran ? `ran ${ran}` : "single request"}</FactSub>
        </FactTip>
      </Fact>

      <Fact label="Requests">
        <FactTip
          tip={
            medianMs != null && slowestMs != null ? (
              <>
                <TooltipFigures
                  rows={[
                    ["Median", formatLatency(medianMs)],
                    ["Slowest", formatLatency(slowestMs)],
                  ]}
                />
                <p className="pt-1 text-[11px] text-muted-foreground">
                  Across the {durations.length} timed requests on this page
                </p>
              </>
            ) : null
          }
        >
          <FactValue>{totalRequests.toLocaleString()}</FactValue>
          <FactSub>
            {averageMs != null
              ? `${formatLatency(Math.round(averageMs))} avg latency`
              : "no timings"}
          </FactSub>
        </FactTip>
      </Fact>

      <Fact label="Tokens">
        <FactTip
          tip={
            <TooltipFigures
              rows={[
                ["Input", totals.inputTokens.toLocaleString()],
                ["Output", totals.outputTokens.toLocaleString()],
                ["Cache read", totals.cacheReadTokens.toLocaleString()],
                ["Cache write", totals.cacheWriteTokens.toLocaleString()],
              ]}
            />
          }
        >
          <FactValue>
            <span className="shrink-0">{formatCompactNumber(tokens)}</span>
            {cached > 0 ? (
              <CacheMeter
                read={totals.cacheReadTokens}
                write={totals.cacheWriteTokens}
              />
            ) : null}
          </FactValue>
          {/* Phones have no room for the cached figure beside the total, so
              it takes the second line there; the split is in the tooltip. */}
          <FactSub>
            {cached > 0 ? (
              <span className="lg:hidden">
                {formatCompactNumber(cached)} cached
              </span>
            ) : null}
            <span className={cn(cached > 0 && "max-lg:hidden")}>
              {formatCompactNumber(totals.inputTokens)} in ·{" "}
              {formatCompactNumber(totals.outputTokens)} out
            </span>
          </FactSub>
        </FactTip>
      </Fact>

      <Fact label="Cost">
        <FactTip
          tip={
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
          }
        >
          {/* The figure is what was billed; subscription traffic is list
            price only, so it never shares the headline with real spend. */}
          <FactValue muted={onPlanOnly}>
            <span>
              {totals.cost == null
                ? "—"
                : formatUsageCost(onPlanOnly ? subscription : billed)}
            </span>
          </FactValue>
          <FactSub>
            {onPlanOnly
              ? "on plan · not billed"
              : subscription > 0
                ? `billed · ${formatUsageCost(subscription)} on plan`
                : saved > 0
                  ? `saved ${formatUsageCost(saved)}`
                  : "metered"}
          </FactSub>
        </FactTip>
      </Fact>

      <Fact
        label={modelEntries.length === 1 ? "Model" : "Models"}
        className="col-span-2 lg:flex-[2_1_240px]"
      >
        {modelEntries.length === 0 ? (
          <FactValue muted>—</FactValue>
        ) : (
          <ModelsFact models={modelEntries} />
        )}
      </Fact>
    </FactsStrip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type ModelEntry = {
  id: string;
  name: string;
  provider: SupportedProvider | null;
  vendor: string;
};

type Trajectory = NonNullable<ReturnType<typeof readTrajectory>>;

/** Phones list up to three; wide shows two. The rest fold into the peek. */
const PHONE_MODELS = 3;
const WIDE_MODELS = 2;

function readTrajectory({
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
  const forkedFrom = lineage?.forkedFrom ?? null;
  if (
    !session.sessionId &&
    !session.sessionSource &&
    origins.length === 0 &&
    !forkedFrom &&
    forks.length === 0
  ) {
    return null;
  }
  return {
    sessionId: session.sessionId ?? null,
    boundBy: session.sessionSource ?? null,
    origins,
    forkedFrom,
    forks,
    forksTruncated: Boolean(lineage?.forksTruncated),
  };
}

/** A fact whose figures open in a tooltip; a plain block without one. */
function FactTip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  if (!tip) return <div>{children}</div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="block w-full min-w-0 cursor-default text-left">
          {children}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">{tip}</TooltipContent>
    </Tooltip>
  );
}

function ModelsFact({ models }: { models: ModelEntry[] }) {
  const phoneHidden = models.length - PHONE_MODELS;
  const wideHidden = models.length - WIDE_MODELS;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 pt-0.5 lg:flex-row lg:items-center lg:gap-3 lg:pt-0">
      {models.slice(0, PHONE_MODELS).map((model, index) => (
        <Tooltip key={model.id}>
          <TooltipTrigger asChild>
            <UnstyledButton
              className={cn(
                "flex min-w-0 cursor-default items-center gap-1.5 text-left",
                index >= WIDE_MODELS && "lg:hidden",
              )}
            >
              <MakerDisc
                provider={model.provider}
                vendor={model.vendor}
                size={18}
                ring={false}
              />
              {/* Phones: name and maker on one line; wide: stacked. Wide
                  names truncate, or a long one runs into its neighbour. */}
              <span className="flex min-w-0 items-baseline gap-1.5 lg:block">
                <span className="block truncate text-sm leading-5 font-medium max-lg:shrink-0">
                  {model.name}
                </span>
                <span className="block truncate text-xs leading-4 text-muted-foreground">
                  {model.vendor}
                </span>
              </span>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-[11px]">
            {model.id}
          </TooltipContent>
        </Tooltip>
      ))}
      {phoneHidden > 0 ? (
        <ModelsPeek
          models={models}
          label={`${phoneHidden} more models`}
          className="self-start text-xs leading-5 text-muted-foreground hover:text-foreground lg:hidden"
        >
          +{phoneHidden} more
        </ModelsPeek>
      ) : null}
      {wideHidden > 0 ? (
        <ModelsPeek
          models={models}
          label={`${wideHidden} more models`}
          className="hidden shrink-0 rounded-sm px-1 text-xs leading-5 text-muted-foreground tabular-nums ring-1 ring-border ring-inset hover:text-foreground lg:inline-block"
        >
          +{wideHidden}
        </ModelsPeek>
      ) : null}
    </div>
  );
}

/**
 * Every model the session used, in a hover card. A tap toggles it too, so
 * phones reach the list.
 */
function ModelsPeek({
  models,
  className,
  label,
  children,
}: {
  models: ModelEntry[];
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120}>
      <HoverCardTrigger asChild>
        <UnstyledButton
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
          className={cn("cursor-default text-left", className)}
        >
          {children}
        </UnstyledButton>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto max-w-sm p-2">
        <p className="px-1 pb-1.5 text-[11px] text-muted-foreground">
          {models.length} {models.length === 1 ? "model" : "models"} in this
          session
        </p>
        <ul className="space-y-1">
          {models.map((model) => (
            <li
              key={model.id}
              className="flex items-center gap-2 rounded-sm px-1 py-0.5"
            >
              <MakerDisc
                provider={model.provider}
                vendor={model.vendor}
                size={20}
                ring={false}
              />
              <span className="min-w-0">
                <span className="block text-sm leading-4 font-medium">
                  {model.name}
                  <span className="pl-1.5 text-[11px] font-normal text-muted-foreground">
                    {model.vendor}
                  </span>
                </span>
                <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground">
                  {model.id}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The trajectory identity. Wide: one line of small label/value pairs, the
 * origins as icons named on hover. Phones: Session and Bound by side by side,
 * then the origins as one line of icons and the lineage below.
 */
function TrajectoryRow({ t }: { t: Trajectory }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs lg:flex lg:flex-wrap lg:items-center lg:gap-x-4 lg:gap-y-1.5">
      <span className="col-span-2 inline-flex items-center gap-1.5 font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>Trajectory</span>
      </span>
      {t.sessionId ? (
        <TrajectoryPair label="Session">
          <Tooltip>
            <TooltipTrigger asChild>
              <UnstyledButton className="min-w-0 cursor-default truncate font-mono">
                {shortId(t.sessionId)}
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-[11px]">
              {t.sessionId}
            </TooltipContent>
          </Tooltip>
          <CopyButton
            text={t.sessionId}
            size={12}
            className="relative after:absolute after:-inset-1 after:content-['']"
          />
        </TrajectoryPair>
      ) : null}
      {t.boundBy ? (
        <TrajectoryPair
          label="Grouped by"
          hint="Where the session id that ties these requests together came from: the header or client field it was read from."
        >
          <span className="truncate">{groupingLabel(t.boundBy)}</span>
        </TrajectoryPair>
      ) : null}
      {t.origins.length > 0 ? (
        <TrajectoryPair
          label={t.origins.length === 1 ? "Source" : "Sources"}
          hint="The apps and features that sent requests into this session, such as a client, chat, or a knowledge base. Hover an icon for its name."
          className="col-span-2"
        >
          <span className="flex min-w-0 gap-1 overflow-x-auto">
            {t.origins.map((origin) => (
              <Tooltip key={origin}>
                <TooltipTrigger asChild>
                  <UnstyledButton
                    aria-label={sourceLabel(origin)}
                    className="inline-flex h-[18px] shrink-0 cursor-default items-center rounded-sm bg-muted px-1 [&_svg]:size-3"
                  >
                    <SourceIcon source={origin} />
                  </UnstyledButton>
                </TooltipTrigger>
                <TooltipContent>{sourceLabel(origin)}</TooltipContent>
              </Tooltip>
            ))}
          </span>
        </TrajectoryPair>
      ) : null}
      {t.forkedFrom ? (
        <TrajectoryPair
          label="Forked from"
          icon={<GitBranch className="size-3" aria-hidden="true" />}
          className="col-span-2"
        >
          <SessionLink sessionId={t.forkedFrom} />
        </TrajectoryPair>
      ) : null}
      {t.forks.length > 0 ? (
        <TrajectoryPair
          label={t.forks.length === 1 ? "Fork" : "Forks"}
          icon={<GitFork className="size-3" aria-hidden="true" />}
          className="col-span-2"
        >
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {t.forks.map((fork) => (
              <SessionLink key={fork} sessionId={fork} />
            ))}
            {t.forksTruncated ? (
              <span className="text-muted-foreground">
                Additional forks not shown
              </span>
            ) : null}
          </span>
        </TrajectoryPair>
      ) : null}
    </div>
  );
}

function TrajectoryPair({
  label,
  hint,
  icon,
  className,
  children,
}: {
  label: string;
  /** Explains a label that is not self-evident, on hover. */
  hint?: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
        {icon}
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <UnstyledButton className="cursor-help underline decoration-muted-foreground/40 decoration-dotted underline-offset-4">
                {label}
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        ) : (
          <span>{label}</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-foreground">
        {children}
      </span>
    </span>
  );
}

/** A link to another session's page, by its shortened id. */
function SessionLink({ sessionId }: { sessionId: string }) {
  return (
    <Link
      href={llmSessionHref(sessionId)}
      aria-label={sessionId}
      title={sessionId}
      className="font-mono underline-offset-2 hover:underline"
    >
      {shortId(sessionId)}
    </Link>
  );
}

function shortId(id: string) {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

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
    // Shrinks with its cell: a cached count far larger than the total (cache
    // reported beside the input) would otherwise run into the next fact.
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-normal tracking-normal whitespace-nowrap text-muted-foreground">
      <span
        aria-hidden="true"
        className="flex h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted"
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
      {/* Phones show the figure on the line below. */}
      <span
        className="min-w-0 truncate max-lg:hidden"
        title={`${total.toLocaleString()} cached`}
      >
        {formatCompactNumber(total)} cached
      </span>
    </span>
  );
}

/** Where the session id came from, in words; the stored value otherwise. */
function groupingLabel(sessionSource: string): string {
  return GROUPING_LABELS[sessionSource] ?? sessionSource;
}

const GROUPING_LABELS: Record<string, string> = {
  // Name the header itself: "Session header" left people asking which one.
  header: "X-Archestra-Session-Id header",
  meta_header: "X-Archestra-Meta header",
  appa_header: "X-Appa-Session-ID header",
  openwebui_chat: "Open WebUI chat",
  codex_session: "Codex session",
  opencode_session: "OpenCode session",
  kilo_session: "Kilo session",
  claude_metadata: "Claude session",
  claude_code_header: "Claude Code session",
  claude_code: "Claude session",
  claude_desktop: "Claude session",
  openai_user: "OpenAI user field",
  chat: "Chat conversation",
};
