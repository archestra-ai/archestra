"use client";

import Link from "next/link";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useModelPools } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import { OVERVIEW_GRID, OverviewCell, OverviewSection } from "./overview-parts";

const OUTCOME_LABELS: Record<string, string> = {
  answered: "Answered",
  failed_over: "Failed over",
  failed: "Failed",
};

/**
 * Which pool member this request went to, and how that attempt ended. A
 * request that failed over writes one row per attempt, so the failed member's
 * row carries the reason and the next row carries the answer.
 */
export function PoolAttempt({ row }: { row: PoolAttemptRow }) {
  // Most requests go through no pool, and those render nothing and fetch
  // nothing. Neither do older pooled requests while model pools (a beta
  // feature) are off, since their API is gone.
  const poolsEnabled = useFeature("llmModelPoolsEnabled") === true;
  if (!row.modelPoolId || !poolsEnabled) return null;
  return <PoolAttemptSection row={row} />;
}

type PoolAttemptRow = {
  modelPoolId?: string | null;
  providerApiKeyId?: string | null;
  attempt?: number | null;
  attemptOutcome?: string | null;
  failureReason?: string | null;
};

function PoolAttemptSection({ row }: { row: PoolAttemptRow }) {
  const { data: canReadPools } = useHasPermissions({ llmModel: ["read"] });
  const { data: pools = [] } = useModelPools({
    enabled: Boolean(canReadPools),
    toastOnError: false,
  });
  const pool = pools.find((candidate) => candidate.id === row.modelPoolId);
  const member = pool?.members.find(
    (candidate) => candidate.providerApiKeyId === row.providerApiKeyId,
  );
  const outcome = row.attemptOutcome ?? "";

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
      <dl className={OVERVIEW_GRID}>
        <OverviewCell label="Pool">
          {pool ? (
            <Link href="/llm/model-pools" className="hover:underline">
              {pool.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">Deleted pool</span>
          )}
        </OverviewCell>
        <OverviewCell label="Provider key">
          <span title={row.providerApiKeyId ?? undefined}>
            {member?.providerApiKeyName ?? "Not in the pool now"}
          </span>
        </OverviewCell>
        <OverviewCell
          label="Outcome"
          className={row.failureReason ? undefined : "col-span-2"}
        >
          <span
            className={cn(
              outcome === "answered" &&
                "text-emerald-700 dark:text-emerald-400",
              outcome !== "answered" && "text-red-700 dark:text-red-400",
            )}
          >
            {OUTCOME_LABELS[outcome] ?? outcome}
          </span>
        </OverviewCell>
        {row.failureReason ? (
          <OverviewCell label="Reason">
            <span className="font-mono">{row.failureReason}</span>
          </OverviewCell>
        ) : null}
      </dl>
    </OverviewSection>
  );
}
