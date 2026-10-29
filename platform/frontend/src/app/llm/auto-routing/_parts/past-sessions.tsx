"use client";

import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  clientForExternalAgentIds,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import {
  type AutoRoutingBackfillState,
  type AutoRoutingScorerState,
  useAutoRoutingBackfill,
  useCancelAutoRoutingBackfill,
  useScanAutoRoutingBackfill,
  useScoreAutoRoutingBackfill,
} from "@/lib/auto-routing.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { AddJevKeyLink } from "./add-jev-key";

type Backfill = NonNullable<AutoRoutingBackfillState["backfill"]>;
type ScoreOffer = NonNullable<AutoRoutingBackfillState["scoreOffer"]>;

/**
 * Past sessions from the interaction log the plan can learn from: a free scan
 * counts them, then an explicit, capped scoring run reads a sample with the
 * session scorer. Beside an active plan it folds into one line until opened.
 */
export function PastSessions({
  routingEnabled,
  hasActivePlan,
  canUpdate,
  scorer,
}: {
  routingEnabled: boolean;
  hasActivePlan: boolean;
  canUpdate: boolean;
  scorer: AutoRoutingScorerState;
}) {
  const { data } = useAutoRoutingBackfill();
  const scan = useScanAutoRoutingBackfill();
  const cancel = useCancelAutoRoutingBackfill();
  const [opened, setOpened] = useState(false);
  if (!data) return null;
  const { backfill, scoreOffer } = data;
  const running = backfill?.status === "running";
  if (hasActivePlan && !running && !opened) {
    if (!scoreOffer) {
      return canUpdate ? (
        <Button
          size="xs"
          variant="link"
          className="h-auto p-0 text-sm text-muted-foreground"
          disabled={scan.isPending}
          onClick={() => scan.mutate()}
        >
          Scan past sessions
        </Button>
      ) : null;
    }
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="auto-routing-past-traffic"
      >
        <span className="tabular-nums">
          {scoreOffer.rescore
            ? `The scorer changed: ${count(scoreOffer.remaining)} past sessions to re-score`
            : `${count(scoreOffer.remaining)} past sessions to score`}
        </span>
        {scorer === "no_jev_key" ? (
          <AddJevKeyLink />
        ) : (
          canUpdate && (
            <Button
              size="xs"
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={() => setOpened(true)}
            >
              {scoreOffer.rescore ? "Re-score" : "Score"}
            </Button>
          )
        )}
      </p>
    );
  }

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="auto-routing-past-sessions"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium">Past sessions</h3>
        {canUpdate && !running && (
          <Button
            size="xs"
            variant="link"
            className="ml-auto h-auto p-0 text-sm"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
          >
            {backfill ? "Scan again" : "Scan past sessions"}
          </Button>
        )}
        {canUpdate && running && (
          <Button
            size="xs"
            variant="link"
            className="ml-auto h-auto p-0 text-sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        )}
      </div>
      {backfill ? (
        <BackfillStatus backfill={backfill} routingEnabled={routingEnabled} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Scanning finds the past sessions in the interaction log the plan could
          learn from. It reads the database only and costs nothing.
        </p>
      )}
      {backfill &&
        scoreOffer &&
        (scorer === "no_jev_key" ? (
          <AddJevKeyLink />
        ) : (
          canUpdate && <ScoreAction offer={scoreOffer} />
        ))}
    </section>
  );
}

function BackfillStatus({
  backfill,
  routingEnabled,
}: {
  backfill: Backfill;
  routingEnabled: boolean;
}) {
  if (backfill.status === "running" && backfill.phase === "scan") {
    return <p className="text-sm">Scanning past sessions…</p>;
  }
  const { progress } = backfill;
  const unread = progress
    ? [
        ...(progress.noText > 0
          ? [`${count(progress.noText)} without text`]
          : []),
        ...(progress.failed > 0 ? [`${count(progress.failed)} failed`] : []),
      ]
    : [];
  return (
    <div className="space-y-3 text-sm">
      <details>
        <summary className="cursor-pointer select-none tabular-nums">
          <span data-testid="auto-routing-past-sessions-funnel">
            {[
              ...funnel(backfill.eligibleSessions, progress),
              ...(backfill.status === "running" && backfill.phase === "score"
                ? [`scoring, ${spend(backfill)}`]
                : []),
            ].join(" · ")}
          </span>
        </summary>
        <div className="mt-2 space-y-3 text-muted-foreground tabular-nums">
          <div className="space-y-1">
            <p>
              {formatDate({
                date: backfill.windowStart,
                dateFormat:
                  new Date(backfill.windowStart).getFullYear() ===
                  new Date(backfill.cutoff).getFullYear()
                    ? "MMM d"
                    : "MMM d, yyyy",
              })}{" "}
              –{" "}
              {formatDate({ date: backfill.cutoff, dateFormat: "MMM d, yyyy" })}
            </p>
            {unread.length > 0 && <p>Not scored: {unread.join(", ")}</p>}
            {backfill.phase === "score" && <p>Spent {spend(backfill)}</p>}
          </div>
          <ClientBreakdown breakdown={backfill.breakdown} />
        </div>
      </details>
      {backfill.error && (
        <InlineNotice variant={backfill.status === "failed" ? "error" : "info"}>
          <AlertTriangle />
          <InlineNoticeText>{backfill.error}</InlineNoticeText>
        </InlineNotice>
      )}
      {routingEnabled && backfill.fitBlockedReason && (
        <InlineNotice>
          <AlertTriangle />
          <span className="font-medium">
            No plan is fitted on these sessions
          </span>
          <InlineNoticeText>{backfill.fitBlockedReason}</InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

function spend(backfill: Backfill): string {
  const spent = formatCurrency(backfill.spentCostUsd);
  return backfill.maxCostUsd === null
    ? spent
    : `${spent} of ${formatCurrency(backfill.maxCostUsd)}`;
}

/** Found, then scored; unread sessions count against the sample, not as pending. */
function funnel(found: number, progress: Backfill["progress"]): string[] {
  if (!progress) return [`${count(found)} found`, "none scored yet"];
  const attempted = progress.scored + progress.noText + progress.failed;
  return [
    `${count(found)} found`,
    attempted < progress.sample
      ? `${count(progress.scored)} of ${count(progress.sample)} scored`
      : `${count(progress.scored)} scored`,
  ];
}

/** Sessions per client, largest first; the tail past the top rows folds into "Other". */
function ClientBreakdown({ breakdown }: { breakdown: Backfill["breakdown"] }) {
  const appName = useAppName();
  const totals = new Map<string, number>();
  for (const row of breakdown) {
    const label = clientLabel(row.client, appName);
    totals.set(label, (totals.get(label) ?? 0) + row.sessions);
  }
  const ranked = [...totals]
    .filter(([label]) => label !== OTHER_CLIENTS)
    .sort(([, a], [, b]) => b - a);
  const other =
    (totals.get(OTHER_CLIENTS) ?? 0) +
    ranked.slice(TOP_CLIENTS).reduce((sum, [, sessions]) => sum + sessions, 0);
  const rows = [
    ...ranked.slice(0, TOP_CLIENTS),
    ...(other > 0 ? [[OTHER_CLIENTS, other] as const] : []),
  ];
  if (rows.length === 0) return null;
  const largest = Math.max(...rows.map(([, sessions]) => sessions));
  return (
    <table className="w-full max-w-md text-foreground">
      <tbody>
        {rows.map(([label, sessions]) => (
          <tr key={label}>
            <td className="py-0.5 pr-3 whitespace-nowrap">{label}</td>
            <td className="py-0.5 pr-3 text-right tabular-nums">
              {count(sessions)}
            </td>
            <td className="w-full py-0.5" aria-hidden>
              <div
                className="h-2 rounded-sm bg-primary/60"
                style={{ width: `${(sessions / largest) * 100}%` }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScoreAction({ offer }: { offer: ScoreOffer }) {
  // What the admin confirms, frozen while the dialog is open.
  const [confirming, setConfirming] = useState<{
    offer: ScoreOffer;
    maxCostUsd: number;
  } | null>(null);
  const [ceiling, setCeiling] = useState(offer.suggestedMaxCostUsd.toFixed(2));
  const score = useScoreAutoRoutingBackfill();
  const maxCostUsd = Number(ceiling);
  const ceilingError =
    !Number.isFinite(maxCostUsd) || maxCostUsd <= 0
      ? "Enter a positive amount."
      : maxCostUsd > AUTO_ROUTING_BACKFILL_MAX_COST_USD
        ? `At most ${formatCurrency(AUTO_ROUTING_BACKFILL_MAX_COST_USD)}.`
        : null;
  const verb = offer.rescore ? "Re-score" : "Score";

  return (
    <div className="space-y-2">
      {offer.rescore && (
        <p className="text-sm text-muted-foreground">
          The session scorer changed since these sessions were scored.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={ceilingError !== null}
          onClick={() => setConfirming({ offer, maxCostUsd })}
        >
          {verb} {count(offer.remaining)} sessions · ~
          {formatCurrency(offer.estimatedCostUsd)}
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span>limit $</span>
          <Input
            aria-label="Spending limit (USD)"
            type="number"
            min={0}
            max={AUTO_ROUTING_BACKFILL_MAX_COST_USD}
            step="0.01"
            value={ceiling}
            aria-invalid={ceilingError !== null}
            aria-describedby={
              ceilingError ? "auto-routing-backfill-ceiling-error" : undefined
            }
            onChange={(event) => setCeiling(event.target.value)}
            className="h-8 w-20"
          />
        </span>
      </div>
      {ceilingError && (
        <p
          id="auto-routing-backfill-ceiling-error"
          className="text-sm text-destructive"
        >
          {ceilingError}
        </p>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        {confirming && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{verb} past sessions?</DialogTitle>
              <DialogDescription>
                The opening prompts of these sessions are sent to the Jev
                session scorer.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Window</dt>
                <dd>
                  {formatDate({ date: confirming.offer.windowStart })} to{" "}
                  {formatDate({ date: confirming.offer.cutoff })}
                </dd>
                <dt className="text-muted-foreground">Sessions</dt>
                <dd>{confirming.offer.remaining.toLocaleString("en-US")}</dd>
                <dt className="text-muted-foreground">Spending limit</dt>
                <dd>{formatCurrency(confirming.maxCostUsd)}</dd>
              </dl>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                disabled={score.isPending}
                onClick={() =>
                  score.mutate(
                    {
                      backfillId: confirming.offer.backfillId,
                      scorerVersionId: confirming.offer.scorerVersionId,
                      maxSessions: confirming.offer.sessions,
                      maxCostUsd: confirming.maxCostUsd,
                    },
                    { onSettled: () => setConfirming(null) },
                  )
                }
              >
                {verb} sessions
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

const TOP_CLIENTS = 5;
const OTHER_CLIENTS = "Other";
/** Archestra agents record their delegation chain, agent ids joined by ":", as the client. */
const DELEGATION_CHAIN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/;

function clientLabel(client: string, appName: string): string {
  const family = clientForExternalAgentIds([client]);
  if (family) return family.label;
  return DELEGATION_CHAIN.test(client) ? `${appName} agents` : OTHER_CLIENTS;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
