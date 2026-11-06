"use client";

import { Check, Minus, X } from "lucide-react";
import Link from "next/link";
import { shortModelName } from "@/app/llm/logs/_parts/logs-table-format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useInteractionAutoRouting } from "@/lib/interactions/interaction.query";
import { useModelPools } from "@/lib/model-pools.query";
import { formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import { OverviewSection } from "./overview-parts";
import {
  poolAttemptsOf,
  poolFailureLabel,
  poolFailureText,
} from "./pool-attempts";
import type { InteractionSummary } from "./session-timeline";

/**
 * Why a request used the model and key it did: the auto-routing decision
 * that picked its tier, then the model pool members it tried, in order.
 * Renders nothing for a request that neither routed.
 */
export function RoutingDetails({
  row,
  requests,
}: {
  row: InteractionSummary;
  /** The session's loaded requests, oldest first: a pool attempt's siblings. */
  requests: InteractionSummary[];
}) {
  return (
    <>
      {row.autoRouted ? <AutoRoutingSection row={row} /> : null}
      <PoolSection row={row} requests={requests} />
    </>
  );
}

/** Whether `RoutingDetails` explains this request's model. */
export function hasRoutingDetails(row: InteractionSummary): boolean {
  return row.autoRouted || Boolean(row.modelPoolId);
}

// ============================================================================

const TIERS = [
  { id: "fast", label: "Fast" },
  { id: "normal", label: "Normal" },
  { id: "smart", label: "Smart" },
] as const;

const REASON_LABELS = {
  planned: "planned",
  cold_start: "cold start",
  scorer_error: "scorer error",
  plan_stale: "stale plan",
} as const;

const REASON_EXPLANATIONS = {
  planned: "The budget plan picked this tier from the scorer's reading.",
  cold_start:
    "No budget plan was fitted yet, so the session got the default tier.",
  scorer_error:
    "The scorer could not read the task, so the session got the default tier.",
  plan_stale:
    "The budget plan was out of date, so the session got the default tier.",
} as const;

function AutoRoutingSection({ row }: { row: InteractionSummary }) {
  const { data: decision, isPending } = useInteractionAutoRouting({
    interactionId: row.id,
  });
  if (isPending || !decision) return null;
  const signal = decision.features?.signals["jev-session"] ?? null;
  const decidedHere =
    Date.parse(decision.createdAt) >=
    Date.parse(row.createdAt) - Math.max(0, row.durationMs ?? 0);
  // Only with both prices known: an unpriced request is not a free one.
  const cost = row.cost === null ? null : Number(row.cost);
  const baseline = row.baselineCost === null ? null : Number(row.baselineCost);
  const cheaper =
    cost !== null && baseline !== null && baseline > 0 && cost < baseline
      ? Math.round(((baseline - cost) / baseline) * 100)
      : null;

  return (
    <OverviewSection
      title="Auto routing"
      aside={
        <span className="truncate text-[11px] text-muted-foreground">
          auto → {shortModelName(decision.model.modelId)}
        </span>
      }
    >
      {signal ? (
        <ul
          aria-label="How the scorer read the task"
          className="grid grid-cols-[3.25rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1"
        >
          {TIERS.map((tier, i) => {
            const p = signal.tier_needed[i] ?? 0;
            const chosen = tier.id === decision.tier;
            return (
              <li key={tier.id} className="contents">
                <span
                  className={cn(
                    "text-[11px] leading-4",
                    chosen
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {tier.label}
                </span>
                <span className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      chosen ? "bg-primary" : "bg-foreground/20",
                    )}
                    style={{ width: `${Math.max(2, p * 100)}%` }}
                  />
                </span>
                <span
                  className={cn(
                    "text-right text-[11px] leading-4 tabular-nums",
                    chosen ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {Math.round(p * 100)}%
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p
        className={cn(
          "text-[11px] leading-4 text-muted-foreground",
          signal && "mt-2",
        )}
      >
        <span>Picked </span>
        <span className="font-medium text-foreground">
          {TIERS.find((t) => t.id === decision.tier)?.label}
        </span>{" "}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default underline decoration-muted-foreground/50 decoration-dotted underline-offset-2">
              ({REASON_LABELS[decision.reason]})
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 space-y-0.5 text-[11px] tabular-nums">
            <p>{REASON_EXPLANATIONS[decision.reason]}</p>
            {decision.scorerVersion ? (
              <p>
                Scorer {decision.scorerVersion.name} (
                {shortModelName(decision.scorerVersion.model)})
              </p>
            ) : null}
            {signal ? (
              <p>Long task: {Math.round(signal.p_long * 100)}%</p>
            ) : null}
            <p>
              The plan draws this tier {Math.round(decision.propensity * 100)}%
              of the time
            </p>
            {decision.expectedCostUsd ? (
              <p>
                Expected session cost $
                {Number(decision.expectedCostUsd).toFixed(2)}
              </p>
            ) : null}
          </TooltipContent>
        </Tooltip>
        <Dot />
        <span>
          {decidedHere
            ? "decided on this request"
            : "decided earlier in the session"}
        </span>
        {cheaper !== null ? (
          <>
            <Dot />
            <span className="text-emerald-700 dark:text-emerald-400">
              {cheaper}% cheaper than Smart
            </span>
          </>
        ) : null}
      </p>
    </OverviewSection>
  );
}

type Rung = {
  key: string;
  keyName: string;
  meta: string;
  state: "answered" | "failed" | "not_tried";
  outcome: string;
  current: boolean;
};

function PoolSection({
  row,
  requests,
}: {
  row: InteractionSummary;
  requests: InteractionSummary[];
}) {
  // Model pools are a beta feature: while it is off, their API is gone.
  const poolsEnabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canReadPools } = useHasPermissions({ llmModel: ["read"] });
  const { data: pools = [], isSuccess: poolsLoaded } = useModelPools({
    enabled: poolsEnabled && Boolean(canReadPools) && Boolean(row.modelPoolId),
    toastOnError: false,
  });
  if (!row.modelPoolId || !poolsEnabled) return null;
  const pool = pools.find((candidate) => candidate.id === row.modelPoolId);
  const members = pool?.members ?? [];
  // Without the pool config (no access, or not loaded) names are unknown, not
  // removed.
  const nameOf = (keyId: string | null) =>
    members.find((m) => m.providerApiKeyId === keyId)?.providerApiKeyName ??
    (poolsLoaded ? "Removed key" : "Pool member");

  const { attempts, complete } = poolAttemptsOf(row, requests);
  const tried = new Set(attempts.map((a) => a.providerApiKeyId));
  const rungs: Rung[] = [
    ...attempts.map((attempt): Rung => {
      const failure = poolFailureLabel(attempt.failureReason);
      const answered = attempt.attemptOutcome === "answered";
      return {
        key: attempt.id,
        keyName: nameOf(attempt.providerApiKeyId),
        meta: attempt.model ? shortModelName(attempt.model) : "",
        state: answered ? "answered" : "failed",
        outcome: [
          answered ? "answered" : failure ? poolFailureText(failure) : "failed",
          attempt.durationMs != null ? formatLatency(attempt.durationMs) : null,
        ]
          .filter(Boolean)
          .join(" · "),
        current: attempt.id === row.id,
      };
    }),
    // Only a whole chain shows which members were not needed.
    ...(complete ? members : [])
      .filter((m) => m.enabled && !tried.has(m.providerApiKeyId))
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      .map(
        (m): Rung => ({
          key: m.id,
          keyName: m.providerApiKeyName,
          meta: `priority ${m.priority} · weight ${m.weight}`,
          state: "not_tried",
          outcome: "not needed",
          current: false,
        }),
      ),
  ];

  return (
    <OverviewSection
      title="Model pool"
      aside={
        row.attempt ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            Attempt {row.attempt}
          </span>
        ) : null
      }
    >
      {pool || poolsLoaded ? (
        <p className="mb-2 truncate text-xs">
          {pool ? (
            <Link href="/llm/model-pools" className="hover:underline">
              {pool.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">Deleted pool</span>
          )}
        </p>
      ) : null}
      {members.length > 1 ? (
        <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
          Members are tried by priority. Within a priority a weighted draw picks
          one, and a session keeps it while it answers.
        </p>
      ) : null}
      <ol>
        {rungs.map((rung, i) => (
          <LadderRung
            key={rung.key}
            rung={rung}
            last={i === rungs.length - 1}
          />
        ))}
      </ol>
      {complete ? null : (
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          {(attempts[0].attempt ?? 1) > 1
            ? "Its earlier attempts aren't on this page or can't be told apart from other requests."
            : "Its later attempts aren't on this page or can't be told apart from other requests."}
        </p>
      )}
    </OverviewSection>
  );
}

const RUNG_STATES = {
  answered: {
    icon: Check,
    dot: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    icon: X,
    dot: "bg-red-500/15 text-red-700 dark:text-red-400",
    text: "text-red-700 dark:text-red-400",
  },
  not_tried: {
    icon: Minus,
    dot: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
  },
} as const;

function LadderRung({ rung, last }: { rung: Rung; last: boolean }) {
  const state = RUNG_STATES[rung.state];
  const Icon = state.icon;
  return (
    <li
      className={cn(
        "relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2",
        !last && "pb-2",
      )}
    >
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-[18px] bottom-0.5 left-[7.5px] w-px bg-border"
        />
      )}
      <span
        className={cn(
          "mt-px flex size-4 items-center justify-center rounded-full",
          state.dot,
        )}
        aria-hidden="true"
      >
        <Icon className="size-2.5" strokeWidth={3} />
      </span>
      <div
        className={cn("min-w-0", rung.state === "not_tried" && "opacity-60")}
      >
        <div className="flex min-w-0 items-baseline gap-2 text-xs leading-[18px]">
          <span
            className={cn("truncate", rung.current && "font-medium")}
            title={rung.keyName}
          >
            {rung.keyName}
          </span>
          {rung.current ? (
            <span className="shrink-0 text-[10px] leading-4 text-primary">
              this row
            </span>
          ) : null}
          <span
            className={cn(
              "ml-auto shrink-0 text-[11px] tabular-nums",
              state.text,
            )}
          >
            {rung.outcome}
          </span>
        </div>
        {rung.meta ? (
          <p className="truncate text-[11px] leading-4 text-muted-foreground tabular-nums">
            {rung.meta}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="mx-1 text-muted-foreground/50">
      ·
    </span>
  );
}
